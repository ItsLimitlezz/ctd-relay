// Repository factory: every repo interface from services.ts over one SQLite database.

import type { Repos, SecretBox } from '../services.js';
import { createAccountsRepo } from './accounts-repo.js';
import { createApiTokensRepo } from './api-tokens-repo.js';
import { createAuditRepo } from './audit-repo.js';
import { createAssetLibraryRepo, createBlobsRepo } from './blobs-repo.js';
import { createConnectedAppsRepo } from './connected-apps-repo.js';
import type { Db } from './database.js';
import { createDestinationsRepo } from './destinations-repo.js';
import { createSecretsRepo, createSettingsRepo } from './kv-repos.js';
import { createProfilesRepo } from './profiles-repo.js';
import { createShowProfilesRepo } from './show-profiles-repo.js';
import { statementCache } from './rows.js';
import { createSessionsRepo } from './sessions-repo.js';
import { createUsersRepo } from './users-repo.js';

export { ConflictError, NotFoundError, RevisionConflictError } from './rows.js';
export { publicUser } from './users-repo.js';
export { DefaultProfileError, PROFILE_SLUG_RE, RESERVED_PROFILE_SLUGS, slugify } from './profiles-repo.js';

export function createRepos(db: Db, box: SecretBox): Repos {
  const stmt = statementCache(db);
  const audit = createAuditRepo(stmt);
  audit.prune(); // trim anything left over from a previous run

  return {
    users: createUsersRepo(stmt),
    authSessions: createSessionsRepo(stmt),
    accounts: createAccountsRepo(stmt),
    destinations: createDestinationsRepo(stmt),
    settings: createSettingsRepo(stmt),
    secrets: createSecretsRepo(stmt, box),
    audit: { log: audit.log, list: audit.list },
    apiTokens: createApiTokensRepo(stmt),
    profiles: createProfilesRepo(stmt),
    connectedApps: createConnectedAppsRepo(stmt),
    showProfiles: createShowProfilesRepo(db, stmt),
    blobs: createBlobsRepo(stmt),
    assetLibrary: createAssetLibraryRepo(stmt),
  };
}
