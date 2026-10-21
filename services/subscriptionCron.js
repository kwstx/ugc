const db = require('../db');
const { grantCredits, getPlanEntitlements } = require('./billingService');
const { notify } = require('./notificationService');

/**
 * 4. Scheduled Jobs / Cron Worker (for Quarterly Bonuses & Yearly Plans)
 * Because plans include:
 * - Quarterly bonus credits (+70 Starter, +210 Growth, +650 Scale free/qtr)
 * - Yearly billing (where Stripe bills once per year, but base credits drip monthly and bonus credits drip quarterly)
 * - 7-day trial expiration checks
 *
 * This worker runs on startup and daily (or can be triggered on-demand via API / test runner with a simulated referenceDate).
 */
function runRecurringCreditDripJob(referenceDate = new Date()) {
  const now = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
  const nowMs = now.getTime();
  const nowIso = now.toISOString();

  const activeSubs = db.prepare(`
    SELECT * FROM subscriptions
    WHERE status IN ('trialing', 'active')
  `).all();

  const report = {
    checkedAt: nowIso,
    subscriptionsEvaluated: activeSubs.length,
    trialsConverted: 0,
    monthlyDripsGranted: 0,
    quarterlyBonusesGranted: 0,
    subscriptionsExpired: 0,
    events: []
  };

  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

  for (const sub of activeSubs) {
    const plan = getPlanEntitlements(sub.plan_tier);
    if (!plan) continue;

    // 1. Check if 7-day trial has ended and convert to 'active' (or 'canceled' if cancel_at_period_end)
    if (sub.status === 'trialing' && sub.trial_end) {
      const trialEndMs = new Date(sub.trial_end).getTime();
      if (nowMs >= trialEndMs) {
        if (sub.cancel_at_period_end) {
          db.prepare(`
            UPDATE subscriptions SET status = 'canceled', updated_at = ? WHERE id = ?
          `).run(nowIso, sub.id);
          report.subscriptionsExpired++;
          report.events.push({ subId: sub.id, userId: sub.user_id, action: 'trial_canceled_at_end' });
          continue;
        } else {
          db.prepare(`
            UPDATE subscriptions SET status = 'active', updated_at = ? WHERE id = ?
          `).run(nowIso, sub.id);
          sub.status = 'active';
          report.trialsConverted++;
          report.events.push({ subId: sub.id, userId: sub.user_id, action: 'trial_converted_to_active' });
        }
      }
    }

    // 2. Check if current_period_end has passed and cancel_at_period_end is set
    if (sub.current_period_end) {
      const periodEndMs = new Date(sub.current_period_end).getTime();
      if (nowMs >= periodEndMs && sub.cancel_at_period_end) {
        db.prepare(`
          UPDATE subscriptions SET status = 'canceled', updated_at = ? WHERE id = ?
        `).run(nowIso, sub.id);
        report.subscriptionsExpired++;
        report.events.push({ subId: sub.id, userId: sub.user_id, action: 'period_ended_canceled' });
        continue;
      }
    }

    // 3. Monthly Base Credit Drip for Yearly Plans (since Stripe only fires invoice.paid once a year for annual plans)
    // Also serves as a fallback anniversary check if >= 30 days since last_monthly_grant_at
    const lastMonthlyMs = sub.last_monthly_grant_at
      ? new Date(sub.last_monthly_grant_at).getTime()
      : new Date(sub.created_at).getTime();

    if (sub.billing_interval === 'year' && (nowMs - lastMonthlyMs) >= THIRTY_DAYS_MS) {
      const cycleIndex = Math.floor((nowMs - new Date(sub.created_at).getTime()) / THIRTY_DAYS_MS);
      const refId = `cron_monthly_${sub.id}_m${cycleIndex}`;

      const grantResult = grantCredits(
        sub.user_id,
        plan.monthlyCredits,
        'monthly_grant',
        refId,
        `Annual ${plan.name} Plan monthly credit drip (+${plan.monthlyCredits} credits)`
      );

      db.prepare(`
        UPDATE subscriptions SET last_monthly_grant_at = ?, updated_at = ? WHERE id = ?
      `).run(nowIso, nowIso, sub.id);

      if (!grantResult.alreadyProcessed) {
        report.monthlyDripsGranted++;
        report.events.push({
          subId: sub.id,
          userId: sub.user_id,
          action: 'annual_monthly_drip',
          credits: plan.monthlyCredits,
          newBalance: grantResult.wallet.balance
        });

        notify(
          'brand',
          sub.user_id,
          null,
          'monthly_credit_drip',
          `+${plan.monthlyCredits} Monthly Credits Added`,
          `Your monthly credit allocation for your annual ${plan.name} plan has been deposited.`
        );
      }
    }

    // 4. Quarterly Bonus Credit Drip (+70 Starter, +210 Growth, +650 Scale every 90 days)
    const lastQuarterlyMs = sub.last_quarterly_grant_at
      ? new Date(sub.last_quarterly_grant_at).getTime()
      : new Date(sub.created_at).getTime();

    if ((nowMs - lastQuarterlyMs) >= NINETY_DAYS_MS && plan.quarterlyBonusCredits > 0) {
      const qtrIndex = Math.floor((nowMs - new Date(sub.created_at).getTime()) / NINETY_DAYS_MS);
      const refId = `cron_quarterly_${sub.id}_q${qtrIndex}`;

      const qtrResult = grantCredits(
        sub.user_id,
        plan.quarterlyBonusCredits,
        'quarterly_bonus',
        refId,
        `${plan.name} Plan quarterly bonus (+${plan.quarterlyBonusCredits} free credits/qtr)`
      );

      db.prepare(`
        UPDATE subscriptions SET last_quarterly_grant_at = ?, updated_at = ? WHERE id = ?
      `).run(nowIso, nowIso, sub.id);

      if (!qtrResult.alreadyProcessed) {
        report.quarterlyBonusesGranted++;
        report.events.push({
          subId: sub.id,
          userId: sub.user_id,
          action: 'quarterly_bonus_drip',
          credits: plan.quarterlyBonusCredits,
          newBalance: qtrResult.wallet.balance
        });

        notify(
          'brand',
          sub.user_id,
          null,
          'quarterly_bonus_drip',
          `+${plan.quarterlyBonusCredits} Quarterly Bonus Credits Unlocked!`,
          `Your ${plan.name} quarterly bonus of +${plan.quarterlyBonusCredits} free credits has been added to your wallet.`
        );
      }
    }
  }

  return report;
}

module.exports = {
  runRecurringCreditDripJob
};
