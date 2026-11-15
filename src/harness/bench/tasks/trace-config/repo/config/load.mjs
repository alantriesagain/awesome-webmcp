import { defaults } from "./defaults.mjs";
import { profileFor } from "./env.mjs";
import { profiles } from "./profiles.mjs";
import { regions } from "./regions.mjs";
import { queues } from "./queues.mjs";

/** The worker's settings: defaults plus the profile, region and queue bonuses, then `RETRIES`. */
export const loadSettings = (env = {}) => {
  const environment = profileFor(env.DEPLOY_ENV ?? defaults.environment);
  const region = env.REGION ?? defaults.region;
  const queue = env.QUEUE ?? defaults.queue;
  const profile = profiles[environment] ?? { retryBonus: 0 };
  const place = regions[region] ?? { retryBonus: 0 };
  const target = queues[queue] ?? { retryBonus: 0 };
  let retries = defaults.baseRetries + profile.retryBonus + place.retryBonus + target.retryBonus;
  if (env.RETRIES !== undefined) retries = Number(env.RETRIES);
  return { environment, region, queue, retries };
};
