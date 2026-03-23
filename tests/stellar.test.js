const { verifyTransaction, syncPayments, validatePaymentAgainstFee } = require('../backend/src/services/stellarService');

jest.mock('../backend/src/config/stellarConfig', () => ({
  SCHOOL_WALLET: 'GTEST123',
  ACCEPTED_ASSETS: {
    XLM: { code: 'XLM', type: 'native', issuer: null, displayName: 'Stellar Lumens', decimals: 7 },
    USDC: { code: 'USDC', type: 'credit_alphanum4', issuer: 'GISSUER', displayName: 'USD Coin', decimals: 7 },
  },
  isAcceptedAsset: (code, type) => {
    const assets = {
      XLM: { code: 'XLM', type: 'native' },
      USDC: { code: 'USDC', type: 'credit_alphanum4' },
    };
    const asset = assets[code];
    if (!asset || asset.type !== type) return { accepted: false, asset: null };
    return { accepted: true, asset };
  },
  server: {
    transactions: () => ({
      forAccount: () => ({
        order: () => ({ limit: () => ({ call: async () => ({ records: [] }) }) }),
      }),
      transaction: (hash) => ({
        call: async () => ({
          hash,
          memo: 'STU001',
          created_at: new Date().toISOString(),
          operations: async () => ({
            records: [{ type: 'payment', to: 'GTEST123', amount: '200.0' }],
          }),
        }),

      }),
    }),
  },
}));

jest.mock('../backend/src/models/paymentModel', () => ({
  findOne: jest.fn().mockResolvedValue(null),
  create: jest.fn().mockResolvedValue({}),
  find: jest.fn().mockReturnValue({ sort: jest.fn().mockResolvedValue([]) }),
}));

jest.mock('../backend/src/models/studentModel', () => ({
  findOne: jest.fn().mockResolvedValue({ studentId: 'STU001', feeAmount: 200 }),
  findOneAndUpdate: jest.fn().mockResolvedValue({}),
}));

describe('stellarService', () => {
  test('syncPayments runs without error', async () => {
    await expect(syncPayments()).resolves.toBeUndefined();
  });

  test('verifyTransaction returns payment details with fee validation', async () => {
    const result = await verifyTransaction('abc123');
    expect(result).toMatchObject({
      hash: 'abc123',
      memo: 'STU001',
      amount: 200,
      feeAmount: 200,
    });
    expect(result.feeValidation).toHaveProperty('status', 'valid');
  });
});

describe('validatePaymentAgainstFee', () => {
  test('returns valid when payment matches fee', () => {
    const result = validatePaymentAgainstFee(200, 200);
    expect(result.status).toBe('valid');
  });

  test('returns underpaid when payment is less than fee', () => {
    const result = validatePaymentAgainstFee(150, 200);
    expect(result.status).toBe('underpaid');
  });

  test('returns overpaid when payment exceeds fee', () => {
    const result = validatePaymentAgainstFee(250, 200);
    expect(result.status).toBe('overpaid');
  });

  test('verifyTransaction rejects old transaction', async () => {
    await expect(verifyTransaction('old_tx')).rejects.toThrow('Transaction is too old and cannot be processed.');
  });
});
