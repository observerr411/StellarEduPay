const { server, SCHOOL_WALLET, isAcceptedAsset } = require('../config/stellarConfig');
const Payment = require('../models/paymentModel');
const Student = require('../models/studentModel');
const PaymentIntent = require('../models/paymentIntentModel');

/**
 * Detect asset information from a Stellar payment operation.
 * Returns { assetCode, assetType, assetIssuer } or null if unsupported.
 */
function detectAsset(payOp) {
  const assetType = payOp.asset_type;
  const assetCode = assetType === 'native' ? 'XLM' : payOp.asset_code;
  const assetIssuer = assetType === 'native' ? null : payOp.asset_issuer;

  const { accepted } = isAcceptedAsset(assetCode, assetType);
  if (!accepted) return null;

  return { assetCode, assetType, assetIssuer };
}

/**
 * Normalize a raw amount string to a number with consistent precision.
 */
function normalizeAmount(rawAmount) {
  return parseFloat(parseFloat(rawAmount).toFixed(7));
}

// Fetch recent transactions to the school wallet and record new payments
async function syncPayments() {
  const transactions = await server
    .transactions()
    .forAccount(SCHOOL_WALLET)
    .order('desc')
    .limit(20)
    .call();

  for (const tx of transactions.records) {
    const memo = tx.memo;
    if (!memo) continue;

    // Reject outdated transactions
    if (!isWithinTimeWindow(tx.created_at)) continue;

    const exists = await Payment.findOne({ txHash: tx.hash });
    if (exists) continue;

    const ops = await tx.operations();
    const payOp = ops.records.find(op => op.type === 'payment' && op.to === SCHOOL_WALLET);
    if (!payOp) continue;

    const asset = detectAsset(payOp);
    if (!asset) continue;

    // Find the corresponding payment intent by memo
    const intent = await PaymentIntent.findOne({ memo, status: 'pending' });
    if (!intent) continue;

    const student = await Student.findOne({ studentId: intent.studentId });
    if (!student) continue;

    const paymentAmount = parseFloat(payOp.amount);

    // Validate payment amount against the intent expected amount
    const feeValidation = validatePaymentAgainstFee(paymentAmount, intent.amount);

    await Payment.create({
      studentId: intent.studentId,
      txHash: tx.hash,
      amount: paymentAmount,
      feeAmount: intent.amount,
      feeValidationStatus: feeValidation.status,
      memo,
      confirmedAt: new Date(tx.created_at),
    });

    // Mark intent as completed
    await PaymentIntent.findByIdAndUpdate(intent._id, { status: 'completed' });

    // Only mark as paid if the payment meets or exceeds the required fee
    if (feeValidation.status === 'valid' || feeValidation.status === 'overpaid') {
      await Student.findOneAndUpdate({ studentId: intent.studentId }, { feePaid: true });
    }
  }
}

/**
 * Persist a payment record, enforcing uniqueness on txHash.
 * Returns the saved document, or throws DUPLICATE_TX if already recorded.
 */
async function recordPayment(data) {
  const exists = await Payment.findOne({ txHash: data.txHash });
  if (exists) {
    const err = new Error(`Transaction ${data.txHash} has already been processed`);
    err.code = 'DUPLICATE_TX';
    throw err;
  }
  try {
    return await Payment.create(data);
  } catch (e) {
    // Catch race-condition duplicate key errors from MongoDB
    if (e.code === 11000) {
      const err = new Error(`Transaction ${data.txHash} has already been processed`);
      err.code = 'DUPLICATE_TX';
      throw err;
    }
    throw e;
  }
}

// Verify a single transaction hash against the school wallet
async function verifyTransaction(txHash) {
  const tx = await server.transactions().transaction(txHash).call();

  // 1. Validate transaction success status
  if (tx.successful === false) {
    const err = new Error('Transaction was not successful on the Stellar network');
    err.code = 'TX_FAILED';
    throw err;
  }

  // 2. Extract and validate memo (student ID)
  const memo = tx.memo ? tx.memo.trim() : null;
  if (!memo) {
    const err = new Error('Transaction memo is missing or empty — cannot identify student');
    err.code = 'MISSING_MEMO';
    throw err;
  }

  // 3. Confirm a payment operation exists and destination matches school wallet
  const ops = await tx.operations();
  const payOp = ops.records.find(op => op.type === 'payment' && op.to === SCHOOL_WALLET);
  if (!payOp) {
    const err = new Error(`No payment operation found targeting the school wallet (${SCHOOL_WALLET})`);
    err.code = 'INVALID_DESTINATION';
    throw err;
  }

  // 4. Validate asset type
  const asset = detectAsset(payOp);
  if (!asset) {
    const assetCode = payOp.asset_type === 'native' ? 'XLM' : (payOp.asset_code || payOp.asset_type);
    const err = new Error(`Unsupported asset: ${assetCode}`);
    err.code = 'UNSUPPORTED_ASSET';
    err.assetCode = assetCode;
    throw err;
  }

  const amount = normalizeAmount(payOp.amount);

  // Find corresponding intent
  const intent = await PaymentIntent.findOne({ memo: tx.memo });
  if (!intent) return { hash: tx.hash, error: 'no_matching_intent', message: 'No pending payment intent found for this memo' };

  const student = await Student.findOne({ studentId: intent.studentId });
  const feeValidation = validatePaymentAgainstFee(amount, intent.amount);

  return {
    hash: tx.hash,
    memo: tx.memo,
    intentId: intent._id,
    studentId: intent.studentId,
    amount,
    expectedAmount: intent.amount,
    feeValidation,
    date: tx.created_at,
  };
}

/**
 * Validate a payment amount against the expected fee.
 * @param {number} paymentAmount — the amount actually paid
 * @param {number} expectedFee — the fee the student owes
 * @returns {{ status: string, message: string }}
 */
function validatePaymentAgainstFee(paymentAmount, expectedFee) {
  if (paymentAmount < expectedFee) {
    return {
      status: 'underpaid',
      message: `Payment of ${paymentAmount} is less than the required fee of ${expectedFee}`,
    };
  }
  if (paymentAmount > expectedFee) {
    return {
      status: 'overpaid',
      message: `Payment of ${paymentAmount} exceeds the required fee of ${expectedFee}`,
    };
  }
  return {
    status: 'valid',
    message: 'Payment matches the required fee',
  };
}

module.exports = { syncPayments, verifyTransaction, validatePaymentAgainstFee, recordPayment };
