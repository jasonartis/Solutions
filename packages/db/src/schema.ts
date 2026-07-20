import { boolean, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'

// Drizzle mirror of the SQL in supabase/migrations — used for typed queries.
// The SQL migration (with RLS policies) is the source of truth for the database;
// keep this file in sync with it.

export const profiles = pgTable('profiles', {
  userId: uuid('user_id').primaryKey(), // = auth.users.id
  displayName: text('display_name'),
  isSuperadmin: boolean('is_superadmin').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const orgs = pgTable('orgs', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  settings: jsonb('settings').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const orgMembers = pgTable(
  'org_members',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    role: text('role', { enum: ['owner', 'admin', 'member'] })
      .notNull()
      .default('member'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
)

export const orgModules = pgTable(
  'org_modules',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    moduleKey: text('module_key').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    settings: jsonb('settings').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.moduleKey] })],
)

// Per-module entity/scope tree (20260720010000). A scope node belongs to one
// (org, module); nesting via parentId; `path` is a trigger-computed
// materialized path of node ids driving ancestry coverage. null scope on a
// grant = global.
export const moduleScopeNodes = pgTable('module_scope_nodes', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  moduleKey: text('module_key').notNull(),
  parentId: uuid('parent_id'), // self-ref (module_scope_nodes.id) ON DELETE CASCADE
  name: text('name').notNull(),
  nodeType: text('node_type'),
  path: text('path').notNull().default(''), // trigger-owned; never client-writable
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const moduleRoles = pgTable(
  'module_roles',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    moduleKey: text('module_key').notNull(),
    role: text('role').notNull(),
    // Scoped-grants generalization (20260720010000). scopeRef null = global
    // (today's behavior for every shipped grant). ON DELETE CASCADE — never
    // SET NULL (that would silently promote a scoped seat to global authority).
    scopeRef: uuid('scope_ref').references(() => moduleScopeNodes.id, { onDelete: 'cascade' }),
    grantedBy: uuid('granted_by'), // audit pointer (auth.users.id) ON DELETE SET NULL
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId, t.moduleKey, t.role] })],
)
