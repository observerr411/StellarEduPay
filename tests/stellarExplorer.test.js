'use strict';

process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/test';
process.env.STELLAR_NETWORK = 'testnet';

describe('stellar explorer url builder', () => {
  afterEach(() => {
    jest.resetModules();
  });

  test('builds a testnet explorer URL for a valid hash', () => {
    const { buildTransactionExplorerUrl } = require('../backend/src/utils/stellarExplorer');
    const txHash = 'a'.repeat(64);

    const url = buildTransactionExplorerUrl(txHash);

    expect(url).toBe(`https://stellar.expert/explorer/testnet/tx/${txHash}`);
  });

  test('returns null when hash format is invalid', () => {
    const { buildTransactionExplorerUrl } = require('../backend/src/utils/stellarExplorer');

    expect(buildTransactionExplorerUrl('not-a-hash')).toBeNull();
    expect(buildTransactionExplorerUrl('')).toBeNull();
    expect(buildTransactionExplorerUrl(null)).toBeNull();
  });

  test('builds a public explorer URL when running on mainnet', () => {
    process.env.STELLAR_NETWORK = 'mainnet';
    jest.resetModules();

    const { buildTransactionExplorerUrl } = require('../backend/src/utils/stellarExplorer');
    const txHash = 'b'.repeat(64);

    const url = buildTransactionExplorerUrl(txHash);

    expect(url).toBe(`https://stellar.expert/explorer/public/tx/${txHash}`);
  });
});
