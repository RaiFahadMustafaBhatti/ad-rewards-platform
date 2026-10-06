export const INITIAL_PACKAGES = [
  {
    name: "Platinum",
    pricePaisa: 200_000,
    rewardPerEligibleAdPaisa: 2_000,
    dailyAdLimit: 1,
    durationDays: 120,
    features: ["Eligible advertising access", "Server-validated completion", "Manual withdrawal review"],
  },
  {
    name: "Gold",
    pricePaisa: 350_000,
    rewardPerEligibleAdPaisa: 3_500,
    dailyAdLimit: 1,
    durationDays: 120,
    features: ["Eligible advertising access", "Server-validated completion", "Manual withdrawal review"],
  },
  {
    name: "Diamond",
    pricePaisa: 500_000,
    rewardPerEligibleAdPaisa: 5_000,
    dailyAdLimit: 1,
    durationDays: 120,
    features: ["Eligible advertising access", "Server-validated completion", "Manual withdrawal review"],
  },
] as const;

export const INITIAL_PLATFORM_SETTINGS: Record<string, string> = {
  company_name: "FMB Earning Hub",
  contact_email: "[YOUR SUPPORT EMAIL]",
  contact_phone: "[YOUR SUPPORT PHONE]",
  whatsapp_number: "[YOUR WHATSAPP NUMBER]",
  company_address: "[YOUR BUSINESS ADDRESS]",
  business_hours: "[YOUR BUSINESS HOURS]",
  jazzcash_number: "[YOUR JAZZCASH NUMBER]",
  easypaisa_number: "[YOUR EASYPAISA NUMBER]",
  bank_information: "[YOUR BANK INFORMATION]",
  payment_account_title: "[YOUR ACCOUNT TITLE]",
  minimum_withdrawal_paisa: "200000",
  maximum_withdrawal_paisa: "0",
  withdrawal_fee_paisa: "15000",
  referrals_enabled: "false",
  referral_reward_paisa: "0",
  referral_reward_max_paisa: "0",
  referee_reward_paisa: "0",
  terms_content: "Membership fees do not constitute an investment. Eligible advertising rewards depend on active campaigns, completion validation, package rules, and published platform terms.",
  privacy_content: "We collect account, verification, transaction, and device-security data only as needed to operate the platform, prevent fraud, and meet applicable obligations.",
  refund_content: "Replace this placeholder with the company’s actual refund policy before accepting payments.",
  platform_timezone: "Asia/Karachi",
  platform_availability_status: "ACTIVE",
  platform_availability_start: "",
  platform_availability_end: "",
  platform_reliability_message: "Platform availability is subject to published terms, maintenance, and operational controls.",
  platform_maintenance_notice: "",
  platform_announcement: "",
};

export function formatPkr(paisa: number) {
  return new Intl.NumberFormat("en-PK", {
    style: "currency",
    currency: "PKR",
    maximumFractionDigits: 0,
  }).format(paisa / 100);
}

export function formatDurationDays(days: number) {
  if (days % 30 === 0) {
    const months = days / 30;
    return `${months} month${months === 1 ? "" : "s"}`;
  }
  return `${days} day${days === 1 ? "" : "s"}`;
}
