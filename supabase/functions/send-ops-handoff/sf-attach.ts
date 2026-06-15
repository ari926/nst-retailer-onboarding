// supabase/functions/send-ops-handoff/sf-attach.ts
//
// Two SF operations live here:
//
//  1) uploadHandoffPdf(token, opportunityId, pdf, filename)
//       → POSTs a ContentVersion (multipart/form-data) with PathOnClient + Title
//         and FirstPublishLocationId = the Opportunity Id. SF auto-creates the
//         ContentDocument and a ContentDocumentLink to the Opp. Returns
//         { contentVersionId, contentDocumentId }.
//
//  2) sendOpsHandoffEmail(token, opportunityId, contentDocumentId, params)
//       → Creates an EmailMessage record on the Opportunity (RelatedToId), then
//         creates a ContentDocumentLink so the PDF shows up as an attachment in
//         the email's Lightning view, and an EmailMessageRelation row so the
//         CC'd rep is tracked. Returns the EmailMessage Id.
//
// We use the standard REST API (no Apex). EmailMessage.Status='3' means
// "Sent" in SF's enum. To actually deliver the email, we use the Messaging
// SOAP API equivalent via Apex REST… BUT — for V1 we use the simpler approach:
// send via Resend (or pg_mail) with the PDF attached, and ALSO log an
// EmailMessage record on the Opp so it shows in the activity timeline.
//
// Decision (locked): we send the email itself via Salesforce's
// `/sobjects/EmailMessage` + a follow-up `actions/standard/emailSimple`
// invocable. That keeps the From-address policy (success@) under SF's
// OrgWideEmailAddress governance and ensures bounces flow back into SF.
//
// If actions/standard/emailSimple is not available in the org, we fall back to
// creating the EmailMessage record only (logged but not delivered) and a
// secondary path will send via Resend. In practice this org has it enabled.

import { sfRequest, SfToken, SF_API_VERSION } from './sf-auth.ts';

export interface UploadResult {
  contentVersionId: string;
  contentDocumentId: string;
}

/**
 * Upload a PDF as a ContentVersion attached to an Opportunity. Uses the
 * multipart/form-data flavor of the SF REST API so we can ship the binary
 * file in one round-trip. The "FirstPublishLocationId" field tells SF to
 * automatically create a ContentDocumentLink to the parent record.
 */
export async function uploadHandoffPdf(
  token: SfToken,
  opportunityId: string,
  pdf: Uint8Array,
  filename: string,
  title: string,
): Promise<UploadResult> {
  const url =
    `${token.instance_url}/services/data/${SF_API_VERSION}/sobjects/ContentVersion`;

  // Multipart body.
  // SF expects:
  //   - "entity_content" part: application/json with {Title, PathOnClient, FirstPublishLocationId}
  //   - "VersionData" part: the binary file (any name, must reference in fieldname)
  // The boundary must be unique and not appear in the file or json.
  const boundary = `--------NSTBoundary${crypto.randomUUID()}`;
  const meta = JSON.stringify({
    Title: title,
    PathOnClient: filename,
    FirstPublishLocationId: opportunityId,
    // Optional: Description, ReasonForChange, etc. Keep minimal for V1.
  });

  const enc = new TextEncoder();
  const head1 = enc.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="entity_content"\r\n` +
      `Content-Type: application/json\r\n\r\n` +
      meta +
      `\r\n--${boundary}\r\n` +
      `Content-Disposition: form-data; name="VersionData"; filename="${filename}"\r\n` +
      `Content-Type: application/pdf\r\n\r\n`,
  );
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);

  const bodyLen = head1.length + pdf.length + tail.length;
  const body = new Uint8Array(bodyLen);
  body.set(head1, 0);
  body.set(pdf, head1.length);
  body.set(tail, head1.length + pdf.length);

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`ContentVersion POST → ${resp.status}: ${text.slice(0, 600)}`);
  }
  const created = JSON.parse(text) as { id: string; success: boolean };
  if (!created.id) {
    throw new Error(`ContentVersion POST returned no id: ${text.slice(0, 400)}`);
  }
  const contentVersionId = created.id;

  // Look up the auto-created ContentDocumentId (parent of the ContentVersion).
  const queried = await sfRequest(
    token,
    'GET',
    `/sobjects/ContentVersion/${contentVersionId}?fields=ContentDocumentId`,
  );
  const contentDocumentId = queried?.ContentDocumentId as string | undefined;
  if (!contentDocumentId) {
    throw new Error(
      `ContentVersion ${contentVersionId} has no ContentDocumentId — upload may be malformed`,
    );
  }

  return { contentVersionId, contentDocumentId };
}

export interface SendEmailParams {
  /** Plain-text subject line. */
  subject: string;
  /** HTML body. We embed an inline summary; the PDF goes as the attachment. */
  htmlBody: string;
  /** Primary recipient — operations@ */
  toAddress: string;
  /** CC list — opp owner + anyone else flagged in policy */
  ccAddresses: string[];
  /** Sender — must be an OrgWideEmailAddress Id (e.g. success@) */
  orgWideEmailAddressId: string;
  /** Display name shown in the From header. */
  fromName: string;
}

export interface SendEmailResult {
  emailMessageId: string;
}

/**
 * Send the handoff email via Salesforce. Strategy:
 *   1. Create EmailMessage record (Status=3 = Sent), RelatedToId = Opp,
 *      ToAddress, CcAddresses, Subject, HtmlBody, FromAddress derived from
 *      the OrgWideEmailAddress.
 *   2. Create a ContentDocumentLink linking the PDF (ContentDocumentId) to
 *      the EmailMessage, ShareType='V' (Viewer).
 *   3. Trigger the actual delivery via the standard `emailSimple` invocable
 *      action so SF handles SMTP, OWE display name, and bounce tracking.
 *
 * Returns the EmailMessage Id for audit + idempotency.
 */
export async function sendOpsHandoffEmail(
  token: SfToken,
  opportunityId: string,
  contentDocumentId: string,
  contentVersionId: string,
  params: SendEmailParams,
): Promise<SendEmailResult> {
  // 1) Resolve the OWE Address so we can stamp FromName/FromAddress on the
  //    EmailMessage record (the activity timeline shows these).
  const owe = await sfRequest(
    token,
    'GET',
    `/sobjects/OrgWideEmailAddress/${params.orgWideEmailAddressId}?fields=Address,DisplayName`,
  ) as { Address: string; DisplayName: string };

  // 2) Create the EmailMessage record in DRAFT state first.
  //    Salesforce refuses to accept a ContentDocumentLink on a non-draft
  //    EmailMessage ("You can't create a link for Email Message when it's not
  //    in draft state." INSUFFICIENT_ACCESS_OR_READONLY). So we create as
  //    Status='5' (Draft), attach the PDF, then PATCH to Status='3' (Sent)
  //    for the activity-timeline surface.
  const emailMessage = await sfRequest(token, 'POST', '/sobjects/EmailMessage', {
    Subject: params.subject,
    HtmlBody: params.htmlBody,
    TextBody: stripHtml(params.htmlBody),
    Status: '5',
    Incoming: false,
    MessageDate: new Date().toISOString(),
    FromAddress: owe.Address,
    FromName: params.fromName || owe.DisplayName,
    ToAddress: params.toAddress,
    CcAddress: params.ccAddresses.filter(Boolean).join(';') || null,
    RelatedToId: opportunityId,
    ValidatedFromAddress: owe.Address,
  }) as { id: string };
  const emailMessageId = emailMessage.id;

  // 3) Link the PDF to the (draft) EmailMessage so it shows as an attachment
  //    in the activity timeline. ShareType='V' = Viewer, Visibility='AllUsers'.
  await sfRequest(token, 'POST', '/sobjects/ContentDocumentLink', {
    ContentDocumentId: contentDocumentId,
    LinkedEntityId: emailMessageId,
    ShareType: 'V',
    Visibility: 'AllUsers',
  });

  // 3b) Flip the EmailMessage from Draft ('5') to Sent ('3') now that the
  //     attachment is linked. Activity timeline entry is ready to render.
  await sfRequest(token, 'PATCH', `/sobjects/EmailMessage/${emailMessageId}`, {
    Status: '3',
  });

  // 4) Trigger delivery via the standard emailSimple invocable action.
  //    This is the modern equivalent of Apex Messaging.SingleEmailMessage
  //    but accessible from REST.
  //
  //    IMPORTANT: senderAddress MUST be the OrgWideEmailAddress.Address
  //    string (e.g. 'success@nationalsecuretransport.com'), NOT the OWE Id.
  //    Passing the Id returns:
  //      INVALID_ARGUMENT_TYPE: "Org-Wide Email provided is not valid."
  //    Same fix as send-kickoff-email.
  //
  //    We also propagate any error rather than silently swallowing it —
  //    the previous version logged the EmailMessage record (Status=3 'Sent')
  //    but never actually delivered, so the queue claimed success while
  //    nothing left the org. The caller's processJob will catch + retry.
  // sendRichBody:true tells emailSimple to render emailBody as HTML.
  // Without it the body shows up as raw HTML source in the recipient's
  // mail client (Gmail flags it as spam — see kickoff fix 2026-05-06).
  await sfRequest(token, 'POST', '/actions/standard/emailSimple', {
    inputs: [
      {
        emailAddresses: params.toAddress,
        emailAddressesArray: [
          params.toAddress,
          ...params.ccAddresses.filter(Boolean),
        ],
        emailSubject: params.subject,
        emailBody: params.htmlBody,
        sendRichBody: true,
        senderType: 'OrgWideEmailAddress',
        senderAddress: owe.Address,
        relatedRecordId: opportunityId,
        contentDocumentIds: [contentDocumentId],
        logEmailOnSend: false, // we already logged via EmailMessage above
      },
    ],
  });

  return { emailMessageId };
}

/**
 * Quick HTML-to-text fallback for EmailMessage.TextBody. Not perfect, but
 * sufficient for clients that prefer the text alternative.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>(\r\n)?/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Look up the Opportunity Owner email + name. Used to populate the CC
 * field with the rep automatically.
 */
export async function getOpportunityOwner(
  token: SfToken,
  opportunityId: string,
): Promise<{ email: string | null; name: string | null; ownerId: string | null }> {
  const result = await sfRequest(
    token,
    'GET',
    `/query?q=${encodeURIComponent(
      `SELECT OwnerId, Owner.Email, Owner.Name FROM Opportunity WHERE Id = '${opportunityId}' LIMIT 1`,
    )}`,
  );
  const row = result?.records?.[0];
  if (!row) return { email: null, name: null, ownerId: null };
  return {
    ownerId: row.OwnerId ?? null,
    email: row.Owner?.Email ?? null,
    name: row.Owner?.Name ?? null,
  };
}
