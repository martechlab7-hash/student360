import { migrate } from '../src/db/migrate.js';

export default async function setup() {
  await migrate(process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://s360_owner:s360_owner_dev@localhost:5432/student360_test', () => undefined);
}
