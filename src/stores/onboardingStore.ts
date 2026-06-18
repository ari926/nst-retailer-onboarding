import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { StepId, OnboardingState } from '../types/onboarding';
import { STEPS, TOTAL_STEPS } from '../types/onboarding';


interface OnboardingStore extends OnboardingState {
  setOnboarding: (partial: Partial<OnboardingState>) => void;
  markStepCompleted: (step: StepId) => void;
  setCurrentStep: (step: StepId) => void;
  reset: () => void;
  /** Derived: progress percentage 0-100 */
  getProgress: () => number;
  /** Derived: status of a given step based on completedSteps + currentStep */
  getStepStatus: (step: StepId) => 'completed' | 'in_progress' | 'available' | 'locked';
}

const initialState: OnboardingState = {
  onboardingId: null,
  sfdcAccountId: null,
  storefrontName: null,
  currentStep: 1,
  completedSteps: [],
  locked: true,
};

/**
 * Onboarding state store — persists to localStorage so drafts survive refreshes.
 * Real server-side state lives in Supabase (step_submissions, step_drafts).
 * This store is the client-side working copy only.
 */
export const useOnboardingStore = create<OnboardingStore>()(
  persist(
    (set, get) => ({
      ...initialState,

      setOnboarding: (partial) => set((s) => ({ ...s, ...partial })),

      markStepCompleted: (step) =>
        set((s) => {
          if (s.completedSteps.includes(step)) return s;
          const next = [...s.completedSteps, step].sort((a, b) => a - b);
          return { completedSteps: next };
        }),

      setCurrentStep: (step) => set({ currentStep: step }),

      reset: () => set(initialState),

      getProgress: () => {
        const { completedSteps } = get();
        // Count only real flow steps (1..7). Step 0 (claim) is pre-flow.
        const flowCompleted = STEPS.filter((s) =>
          completedSteps.includes(s.id),
        ).length;
        return Math.min(
          100,
          Math.round((flowCompleted / TOTAL_STEPS) * 100),
        );
      },

      getStepStatus: (step) => {
        const { completedSteps, currentStep } = get();
        if (completedSteps.includes(step)) return 'completed';
        if (step === currentStep) return 'in_progress';
        // Available if all previous steps are completed
        const previousSteps = STEPS.filter((s) => s.id < step).map((s) => s.id);
        const allPreviousDone = previousSteps.every((id) => completedSteps.includes(id));
        return allPreviousDone ? 'available' : 'locked';
      },
    }),
    {
      name: 'nst_onboarding_state',
      version: 1,
    },
  ),
);
