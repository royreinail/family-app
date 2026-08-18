// Sign-in (onboarding step 1) + Calendar connect (step 2) share the same
// Google OAuth flow — the architecture doc's rationale for connecting
// calendar immediately after sign-in, reusing one auth system.
//
// Backlog 1.3 (multi-parent support): which family a signing-in account
// belongs to is decided by services/parentSignIn.js's resolveFamilyForSignIn
// — see that module for the full branching rationale (it's split out
// specifically so that logic has real test coverage without mocking Google's
// API, which this route otherwise can't avoid touching).
import { Router } from 'express';
import { google } from 'googleapis';
import * as familiesRepo from '../repositories/families.js';
import * as googleCredentialsRepo from '../repositories/googleCredentials.js';
import * as familyParentsRepo from '../repositories/familyParents.js';
import { ensureFamilySetup } from '../services/familySetup.js';
import { resolveFamilyForSignIn } from '../services/parentSignIn.js';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

function oauthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    process.env.GOOGLE_OAUTH_REDIRECT_URI
  );
}

export function authRouter() {
  const router = Router();

  router.get('/google', (req, res) => {
    const client = oauthClient();
    // The invite code (if any) rides through Google's own `state` param —
    // it's echoed back verbatim on the callback, so no server-side session
    // stash is needed to carry it across the redirect round-trip.
    const url = client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES, state: req.query.invite || '' });
    res.redirect(url);
  });

  // Public — shown before sign-in, so the invited parent knows what/who
  // they're about to join.
  router.get('/invite/:code', async (req, res) => {
    const family = await familiesRepo.findByInviteCode(req.params.code);
    if (!family) return res.status(404).json({ error: 'This invite link is no longer valid.' });
    res.json({ familyName: family.name });
  });

  router.get('/google/callback', async (req, res) => {
    try {
      const client = oauthClient();
      const { tokens } = await client.getToken(req.query.code);
      client.setCredentials(tokens);
      const oauth2 = google.oauth2({ auth: client, version: 'v2' });
      const { data: profile } = await oauth2.userinfo.get();

      let family = await resolveFamilyForSignIn({
        email: profile.email,
        sessionFamilyId: req.session.familyId,
        inviteCode: req.query.state,
      });
      if (!family) {
        family = await familiesRepo.create({ name: `${profile.given_name || 'Our'} Family` });
      }

      // Self-heals bot_config + rules for any family (new or pre-existing) —
      // see services/familySetup.js for why this can't just happen once at creation.
      await ensureFamilySetup(family.id);

      // Record this account as an authorized parent for the family, if it
      // isn't already (covers both genuinely-new parents and the legacy
      // backfill case from branch 2 above).
      const alreadyAuthorized = await familyParentsRepo.findByEmail(profile.email);
      if (!alreadyAuthorized) {
        await familyParentsRepo.create({ familyId: family.id, googleAccountEmail: profile.email });
      }

      // Calendar credentials stay tied to whichever single account
      // connected first — a second parent joining shares that connection
      // rather than silently replacing it with their own. Only write here
      // when there's no existing connection, or this is the same account
      // refreshing its own tokens.
      const existingCredentials = await googleCredentialsRepo.findByFamilyId(family.id);
      if (!existingCredentials || existingCredentials.google_account_email === profile.email) {
        await googleCredentialsRepo.upsert({
          familyId: family.id,
          googleAccountEmail: profile.email,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          scope: tokens.scope,
          expiryDate: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
        });
      }

      req.session.familyId = family.id;
      res.redirect(process.env.WEB_APP_URL ? `${process.env.WEB_APP_URL}/onboarding` : '/onboarding');
    } catch (err) {
      console.error('OAuth callback failed', err);
      res.status(500).send('Google sign-in failed. Please try again.');
    }
  });

  router.get('/session', async (req, res) => {
    if (!req.session.familyId) return res.json({ signedIn: false });
    const family = await familiesRepo.findById(req.session.familyId);
    if (!family) return res.json({ signedIn: false });
    await ensureFamilySetup(family.id);
    const credentials = await googleCredentialsRepo.findByFamilyId(family.id);
    res.json({
      signedIn: true,
      family: { id: family.id, name: family.name, timezone: family.timezone, pinSet: !!family.pin_hash },
      calendarConnected: !!credentials,
      googleAccountEmail: credentials?.google_account_email ?? null,
    });
  });

  router.post('/logout', (req, res) => {
    req.session = null;
    res.json({ ok: true });
  });

  return router;
}
