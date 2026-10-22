// Dashboard accounts can be plain usernames: Supabase needs an email, so "2mgincorporated" is stored as
// "2mgincorporated@users.opportunity-radar.invalid" (.invalid never receives mail). Same rule in
// tools/add-user.js.
export const USERNAME_DOMAIN = 'users.opportunity-radar.invalid';

export const toLoginEmail = (name) => (name.includes('@') ? name : `${name}@${USERNAME_DOMAIN}`).toLowerCase();

export const displayName = (email = '') => email.replace(`@${USERNAME_DOMAIN}`, '');
