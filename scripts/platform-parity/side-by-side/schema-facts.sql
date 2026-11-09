-- One line per schema fact of a live database, for a fact-by-fact comparison of two editions
-- (temporary parity harness, RTL-45; from the platform split audit).
select 'table|' || table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE'
union all
select 'column|' || c.table_name || '|' || c.column_name || '|' || c.data_type || coalesce('(' || c.character_maximum_length || ')','') || '|' || c.udt_name || '|null=' || c.is_nullable || '|default=' || coalesce(c.column_default,'')
  from information_schema.columns c where c.table_schema='public'
union all select 'index|' || tablename || '|' || indexname || '|' || indexdef from pg_indexes where schemaname='public'
union all select 'constraint|' || rel.relname || '|' || con.conname || '|' || con.contype::text || '|' || pg_get_constraintdef(con.oid) from pg_constraint con join pg_class rel on rel.oid=con.conrelid join pg_namespace n on n.oid=rel.relnamespace where n.nspname='public'
union all select 'reloptions|' || c.relname || '|' || array_to_string(c.reloptions, ',') from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.reloptions is not null
union all select 'toast_reloptions|' || c.relname || '|' || array_to_string(t.reloptions, ',') from pg_class c join pg_class t on t.oid=c.reltoastrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and t.reloptions is not null
union all select 'extension|' || extname from pg_extension
union all select 'trigger|' || event_object_table || '|' || trigger_name || '|' || action_timing || ' ' || event_manipulation from information_schema.triggers where trigger_schema='public'
union all select 'function|' || routine_name from information_schema.routines where routine_schema='public'
union all select 'sequence|' || sequence_name from information_schema.sequences where sequence_schema='public'
union all select 'view|' || table_name from information_schema.views where table_schema='public'
union all select 'matview|' || matviewname from pg_matviews where schemaname='public'
union all select 'enum|' || t.typname || '|' || string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_type t join pg_enum e on e.enumtypid=t.oid group by t.typname
union all select 'statistics|' || stxname from pg_statistic_ext
union all select 'colstorage|' || c.relname || '|' || a.attname || '|' || a.attstorage::text || '|stat=' || a.attstattarget from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and a.attnum>0 and not a.attisdropped and (a.attstattarget is not null and a.attstattarget >= 0)
order by 1;
