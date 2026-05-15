-- Add CashAccount.cmbBindAccount for binding cash account to a real CMB (招行) account
-- When non-null, the frontend will fetch live balance from /api/cmb/balance?account=<value>
ALTER TABLE "cash_accounts" ADD COLUMN "cmbBindAccount" TEXT;
