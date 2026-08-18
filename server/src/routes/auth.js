// Sign-in (onboarding step 1) + Calendar connect (step 2) share the same
// Google OAuth flow — the architecture doc's rationale for connecting
// calendar immediately after sign-in, reusing one auth system.
import { Router } from 'express';
import { google } from 'googleapis';
import * as familiesRepo from '../repositories/families.js';
import * as googleCredentialsRepo from '../repositories/googleCredentials.js';
import * as botConfigRepo from '../repositories/botConfig.js';

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
    const url = client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });
    res.redirect(url);
  });

  router.get('/google/callback', async (req, res) => {
    try {
      const client = oauthClient();
      const { tokens } = await client.getToken(req.query.code);
      client.setCredentials(tokens);
      const oauth2 = google.oauth2({ auth: client, version: 'v2' });
      const { data: profile } = await oauth2.userinfo.get();

      let familyId = req.session.familyId;
      let family;
      if (familyId) {
        family = await familiesRepo.findById(familyId);
      }
      if (!family) {
        family = await familiesRepo.create({ name: `${profile.given_name || 'Our'} Family` });
        const config = await botConfigRepo.create({ familyId: family.id });
        await botConfigRepo.syncFromEnv(config.id);
      }

      await googleCredentialsRepo.upsert({
        familyId: family.id,
        googleAccountEmail: profile.email,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        scope: tokens.scope,
        expiryDate: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
      });

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
