'use strict';

const HASH_REGEX = /^[a-f0-9]{64}$/i;

function getExplorerNetworkSegment() {
  return String(process.env.STELLAR_NETWORK || 'testnet').toLowerCase() === 'mainnet'
    ? 'public'
    : 'testnet';
}

function buildTransactionExplorerUrl(txHash) {
  if (!txHash || typeof txHash !== 'string') return null;
  const normalized = txHash.trim();
  if (!HASH_REGEX.test(normalized)) return null;

  return `https://stellar.expert/explorer/${getExplorerNetworkSegment()}/tx/${normalized}`;
}

module.exports = {
  getExplorerNetworkSegment,
  buildTransactionExplorerUrl,
};
