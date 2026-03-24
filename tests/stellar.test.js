const { verifyTransaction, syncPayments, validatePaymentAgainstFee, recordPayment } = require('../backend/src/services/stellarService');

// Base mock transaction factory
function makeTx(overrides = {}) {
  return {
    hash: 'abc123',
    memo: 'STU001',
    successful: true,
    created_at: new Date().toISOString(),
    operations: async () => ({
      records: [{ type: 'payment', to: 'GTEST123', amount: '200.0000000', asset_type: 'native' }],
    }),
    ...overrides,
  };
}

jest.mock('../backend/src/config/stellarConfig', () => ({
  SCHOOL_WALLET: 'GTEST123',
  isAcceptedAsset: () => ({ accepted: true }),
  server: {
    transactions: () => ({
      forAccount: () => ({
        order: () => ({ limit: () => ({ call: async () => ({ records: [] }) }) }),
      }),
      transaction: (txHash) => ({
        call: async () => ({
          hash: txHash,
          memo: 'ABCD123',
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

jest.mock('../backend/src/models/paymentIntentModel', () => ({
  findOne: jest.fn().mockResolvedValue({ _id: 'intent123', studentId: 'STU001', amount: 200, memo: 'ABCD123', status: 'pending' }),
  findByIdAndUpdate: jest.fn().mockResolvedValue({}),
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
      expectedAmount: 200,
    });
    await expect(verifyTransaction('badasset')).rejects.toMatchObject({ code: 'UNSUPPORTED_ASSET' });
    server.transactions = original;
  });
});

describe('validatePaymentAgainstFee', () => {
  test('returns valid when payment matches fee', () => {
    expect(validatePaymentAgainstFee(200, 200).status).toBe('valid');
  });

  test('returns underpaid when payment is less than fee', () => {
    expect(validatePaymentAgainstFee(150, 200).status).toBe('underpaid');
  });

  test('returns overpaid when payment exceeds fee', () => {
    const result = validatePaymentAgainstFee(250, 200);
    expect(result.status).toBe('overpaid');
  });

  test('verifyTransaction rejects old transaction', async () => {
    await expect(verifyTransaction('old_tx')).rejects.toThrow('Transaction is too old and cannot be processed.');
  });
});
