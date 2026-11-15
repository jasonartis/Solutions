-- tables where authenticated has a SELECT arm keyed on auth.uid() and NO policy on the table mentions is_superadmin()
with pol as (
  select c.relname, p.polname, pg_get_expr(p.polqual, p.polrelid) as qual, p.polcmd
  from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
)
select relname,
       string_agg(polname, ', ' order by polname) filter (where qual ilike '%auth.uid()%' and polcmd in ('r','*')) as self_read_arms
from pol
group by relname
having bool_or(qual ilike '%auth.uid()%' and polcmd in ('r','*'))
   and not bool_or(qual ilike '%is_superadmin%')
order by relname;
select count(*) as control_total_public_tables_with_policies from (select distinct polrelid from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public') t;
