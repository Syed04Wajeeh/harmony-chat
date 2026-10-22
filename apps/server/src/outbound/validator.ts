import { AppError } from '../errors.js';
import { OutboundError, resolveTarget, type PrivateAllowlist } from './policy.js';

/** Save-time check of a user-supplied URL; the request-time check in `safeFetch` is the real gate. */
export class OutboundValidator {
  constructor(private readonly allowlist: PrivateAllowlist) {}

  async assert(url: string, ownerIsAdmin: boolean): Promise<void> {
    try {
      await resolveTarget(url, { ownerIsAdmin, allowlist: this.allowlist });
    } catch (error) {
      if (!(error instanceof OutboundError)) throw error;
      const code = error.code === 'blocked_address' ? 'url_not_allowed' : 'invalid_url';
      throw new AppError(400, code, error.message);
    }
  }
}
