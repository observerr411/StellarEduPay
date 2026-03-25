'use strict';

const express = require('express');
const router = express.Router();
const {
  getPaymentInstructions,
  createPaymentIntent,
  submitTransaction,
  verifyPayment,
  syncAllPayments,
  finalizePayments,
  getStudentPayments,
  getAcceptedAssets,
  getOverpayments,
  getStudentBalance,
  getSuspiciousPayments,
  getPendingPayments,
  getRetryQueue,
} = require('../controllers/paymentController');

const { validateStudentIdParam, validateVerifyPayment } = require('../middleware/validate');

// Static routes first (before :studentId wildcard)
router.get('/accepted-assets', getAcceptedAssets);
router.get('/overpayments', getOverpayments);
router.get('/suspicious', getSuspiciousPayments);
router.get('/pending', getPendingPayments);
router.get('/retry-queue', getRetryQueue);

// POST routes
router.post('/intent', createPaymentIntent);
router.post('/submit', submitTransaction);
router.post('/verify', validateVerifyPayment, verifyPayment);
router.post('/sync', syncAllPayments);
router.post('/finalize', finalizePayments);

// Parameterized routes
router.get('/balance/:studentId', validateStudentIdParam, getStudentBalance);
router.get('/instructions/:studentId', validateStudentIdParam, getPaymentInstructions);
router.get('/:studentId', validateStudentIdParam, getStudentPayments);

module.exports = router;
