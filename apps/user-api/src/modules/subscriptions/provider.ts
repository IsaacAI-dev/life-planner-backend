/**
 * Payment-provider seam. The app only depends on this interface, so a real
 * provider (e.g. Stripe) can be dropped in later without touching the service.
 * For now `mockProvider` always succeeds and returns synthetic references.
 */
export interface CreateSubscriptionResult {
  providerRef: string;
}

export interface PaymentProvider {
  readonly name: string;
  createSubscription(userId: string, plan: string): Promise<CreateSubscriptionResult>;
  cancelSubscription(providerRef: string | null): Promise<void>;
}

export const mockProvider: PaymentProvider = {
  name: 'mock',
  async createSubscription(userId, plan) {
    return { providerRef: `mock_${plan}_${userId}` };
  },
  async cancelSubscription() {
    // No-op for the mock provider.
  },
};

/** Active provider. Swap this for a real implementation when wiring billing. */
export const paymentProvider: PaymentProvider = mockProvider;
