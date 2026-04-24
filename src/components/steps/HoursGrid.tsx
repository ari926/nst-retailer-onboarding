import { useTranslation } from 'react-i18next';
import { Controller, useFormContext } from 'react-hook-form';
import type { Step1Values } from '../../pages/steps/Step1Profile.schema';

export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type DayKey = typeof DAYS[number];

/**
 * Grid of 7 days with open/close time pickers or a "closed" toggle.
 * Renders inside an RHF FormProvider so we can useFormContext() for control.
 */
export function HoursGrid() {
  const { t } = useTranslation();
  const { register, control, watch, formState: { errors } } = useFormContext<Step1Values>();

  return (
    <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="field-label">{t('step_1_profile.fields.hours_title')}</legend>
      <div className="hours-grid" style={{ marginTop: 'var(--space-3)' }}>
        {DAYS.map((day) => {
          const closedWatch = watch(`hours.${day}.closed`);
          return (
            <div key={day} className="hours-row">
              <div className="hours-row__day">
                {t(`step_1_profile.fields.days.${day}`)}
              </div>

              <label className="row row-sm hours-row__closed" style={{ cursor: 'pointer' }}>
                <Controller
                  name={`hours.${day}.closed`}
                  control={control}
                  render={({ field }) => (
                    <input
                      type="checkbox"
                      className="checkbox"
                      checked={!!field.value}
                      onChange={(e) => field.onChange(e.target.checked)}
                    />
                  )}
                />
                <span className="text-sm">{t('step_1_profile.fields.hours_closed')}</span>
              </label>

              <label className="field hours-row__time">
                <span className="visually-hidden">
                  {t('step_1_profile.fields.hours_open')}
                </span>
                <input
                  type="time"
                  className="input"
                  disabled={closedWatch}
                  {...register(`hours.${day}.open`)}
                />
              </label>

              <label className="field hours-row__time">
                <span className="visually-hidden">
                  {t('step_1_profile.fields.hours_close')}
                </span>
                <input
                  type="time"
                  className="input"
                  disabled={closedWatch}
                  {...register(`hours.${day}.close`)}
                />
              </label>
            </div>
          );
        })}
      </div>

      {errors.hours && (
        <span className="field-error" style={{ marginTop: 'var(--space-2)' }}>
          {errors.hours.root?.message || errors.hours.message || 'Hours are required'}
        </span>
      )}
    </fieldset>
  );
}
