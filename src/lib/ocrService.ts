/**
 * OCR service — wraps AWS Textract for pulling banking details from the
 * signed cash info form that SFDC uploads.
 *
 * V1: mock implementation that returns canned data after a simulated
 * network delay. Real Textract integration lands in PR #11 (SFDC sync),
 * where a Salesforce webhook hands us the S3 key of the signed form and
 * we call Textract's AnalyzeDocument (FORMS + TABLES).
 *
 * Shape of returned data is stable so the real implementation is a
 * drop-in replacement.
 */

import { supabase } from './supabase';
import { MOCK_AUTH_ENABLED } from '../hooks/useAuth';

export interface BankingOcrResult {
  bankName: string;
  accountLast4: string;
  routingNumber: string;
  signerName: string;
  /** 0-1 confidence from Textract. < 0.7 triggers manual-entry fallback. */
  confidence: number;
  /** If false, the UI must show the manual-entry form. */
  success: boolean;
  /** URL (or signed URL) to the original form for reference. */
  sourceDocumentUrl?: string;
}

/**
 * Fetch OCR'd banking details for a retailer. In mock mode returns
 * deterministic fake data. In real mode, calls the `/functions/v1/ocr-banking`
 * Supabase Edge Function which calls Textract.
 */
export async function fetchBankingOcr(
  sfdcAccountId: string,
): Promise<BankingOcrResult> {
  if (MOCK_AUTH_ENABLED) {
    // Simulate 800ms network + Textract latency
    await new Promise((r) => setTimeout(r, 800));

    // Deterministic mock based on last char of sfdc id so manual entry
    // can be tested by seeding sfdcAccountId ending in 'X'.
    const failOcr = sfdcAccountId.endsWith('X');
    if (failOcr) {
      return {
        bankName: '',
        accountLast4: '',
        routingNumber: '',
        signerName: '',
        confidence: 0,
        success: false,
      };
    }
    return {
      bankName: 'First National Bank of Philadelphia',
      accountLast4: '4821',
      routingNumber: '031000053',
      signerName: 'Ari Raptis',
      confidence: 0.94,
      success: true,
    };
  }

  const { data, error } = await supabase.functions.invoke<BankingOcrResult>(
    'ocr-banking',
    { body: { sfdc_account_id: sfdcAccountId } },
  );
  if (error || !data) {
    return {
      bankName: '',
      accountLast4: '',
      routingNumber: '',
      signerName: '',
      confidence: 0,
      success: false,
    };
  }
  return data;
}
