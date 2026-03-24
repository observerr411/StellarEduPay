const express = require('express');
const router = express.Router();
const {
  getPaymentInstructions,
  createPaymentIntent,
  verifyPayment,
  syncAllPayments,
  getStudentPayments,
  getAcceptedAssets,
  getOverpayments,
  getStudentBalance,
  getSuspiciousPayments,
  getPendingPayments,
  finalizePayments,
  getRetryQueue,
} = require('../controllers/paymentController');
const { validateStudentIdParam, validateVerifyPayment } = require('../middleware/validate');

// Static routes first (before :studentId wildcard)
router.get('/accepted-assets', getAcceptedAssets);
router.get('/overpayments', getOverpayments);
router.get('/suspicious', getSuspiciousPayments);
router.get('/pending', getPendingPayments);
router.get('/balance/:studentId', validateStudentIdParam, getStudentBalance);
router.get('/instructions/:studentId', validateStudentIdParam, getPaymentInstructions);
router.get('/:studentId', validateStudentIdParam, getStudentPayments);
router.get('/retry-queue', getRetryQueue);
router.get('/balance/:studentId', validateStudentIdParam, getStudentBalance);
router.get('/instructions/:studentId', validateStudentIdParam, getPaymentInstructions);
router.get('/:studentId', validateStudentIdParam, getStudentPayments);

router.post('/intent', createPaymentIntent);
router.post('/verify', validateVerifyPayment, verifyPayment);
router.post('/sync', syncAllPayments);
router.post('/finalize', finalizePayments);

module.exports = router;
