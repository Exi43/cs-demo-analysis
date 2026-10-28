-- CS Demo Analysis: Team-Sync (Supabase). Einmal komplett im SQL-Editor ausführen; mehrfach ausführen schadet nicht (idempotent).
-- Rechte (Row Level Security): admin = alles im eigenen Team (Freigabe, Rollen/Rechte, Einladungscode), mehrere Admins erlaubt.
-- player = alles lesen, Team-Lineups anlegen und eigene ändern, Strats nur als Vorschlag ('proposed'), abstimmen (eigene Stimme),
-- eigener Lern-Status, eigene Notizen, eigenes Profil (Name/SteamID, nicht perm/roles).
-- Anmeldung: anonym (je PC ein Auth-User). Beitritt nur über den Einladungscode (RPC join_team). Ein Nutzer ist in höchstens einem Team.
-- Sync: jede Tabelle hat updated_at (Server-Zeit, Trigger) und weiches Löschen (deleted); die App holt per RPC sync(since) nur Änderungen.
-- Speicher: Bucket „clips“ (privat), Pfade <team>/clip/<uuid>.webm und <team>/img/<sha1>.webp, Team-Limit 800 MB (Server prüft).

-- ---------------------------------------------------------------- Tabellen

create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 60),
  map_pool jsonb not null default '[]' check (octet_length(map_pool::text) < 20000),
  focus text check (length(focus) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Einladungscode getrennt: nur Admins dürfen ihn lesen (RLS kann keine einzelnen Spalten verstecken)
create table if not exists public.team_invites (
  team_id uuid primary key references public.teams on delete cascade,
  code text not null unique,
  updated_at timestamptz not null default now()
);

create table if not exists public.members (
  team_id uuid not null references public.teams on delete cascade,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null check (length(name) between 1 and 40),
  steamid text check (length(steamid) <= 32),
  perm text not null default 'player' check (perm in ('admin', 'player')),
  roles text[] not null default '{}' check (cardinality(roles) <= 12),
  joined_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted boolean not null default false,
  primary key (team_id, user_id)
);
create unique index if not exists members_one_team on public.members (user_id) where not deleted;

create table if not exists public.strats (
  id uuid primary key,
  team_id uuid not null references public.teams on delete cascade,
  author uuid not null default auth.uid(),
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected', 'archived')),
  base_id uuid,
  decided_by uuid,
  data jsonb not null default '{}' check (octet_length(data::text) < 200000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted boolean not null default false
);

create table if not exists public.votes (
  strat_id uuid not null references public.strats on delete cascade,
  member_id uuid not null default auth.uid(),
  team_id uuid not null references public.teams on delete cascade,
  value smallint not null check (value in (1, -1)),
  comment text check (length(comment) <= 1000),
  updated_at timestamptz not null default now(),
  primary key (strat_id, member_id)
);

create table if not exists public.progress (
  member_id uuid not null default auth.uid(),
  team_id uuid not null references public.teams on delete cascade,
  ref_kind text not null check (ref_kind in ('strat', 'lineup')),
  ref_id uuid not null,
  status text not null check (status in ('learning', 'unsure', 'ready')),
  updated_at timestamptz not null default now(),
  primary key (member_id, ref_kind, ref_id)
);

create table if not exists public.notes (
  id uuid primary key,
  team_id uuid not null references public.teams on delete cascade,
  author uuid not null default auth.uid(),
  data jsonb not null default '{}' check (octet_length(data::text) < 200000),
  updated_at timestamptz not null default now(),
  deleted boolean not null default false
);

-- Team-Lineups: das ganze Lineup als JSON (wie im Utility-Dashboard), Ersteller für die Rechte
create table if not exists public.lineups (
  id uuid primary key,
  team_id uuid not null references public.teams on delete cascade,
  created_by uuid not null default auth.uid(),
  data jsonb not null default '{}' check (octet_length(data::text) < 100000),
  updated_at timestamptz not null default now(),
  deleted boolean not null default false
);

-- ein Clip je Team-Lineup (Datei im Bucket „clips“)
create table if not exists public.clips (
  lineup_id uuid primary key references public.lineups on delete cascade,
  team_id uuid not null references public.teams on delete cascade,
  path text not null unique,
  bytes bigint not null check (bytes between 1 and 16777216),
  duration_s real not null check (duration_s > 0 and duration_s <= 61),
  created_by uuid not null default auth.uid(),
  updated_at timestamptz not null default now(),
  deleted boolean not null default false
);

create index if not exists strats_sync on public.strats (team_id, updated_at);
create index if not exists votes_sync on public.votes (team_id, updated_at);
create index if not exists progress_sync on public.progress (team_id, updated_at);
create index if not exists notes_sync on public.notes (team_id, updated_at);
create index if not exists lineups_sync on public.lineups (team_id, updated_at);
create index if not exists clips_sync on public.clips (team_id, updated_at);
create index if not exists members_sync on public.members (team_id, updated_at);

-- ---------------------------------------------------------------- Hilfsfunktionen

-- updated_at immer vom Server (die App vertraut nicht auf die Uhr der PCs)
create or replace function public.touch() returns trigger language plpgsql as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['teams', 'team_invites', 'members', 'strats', 'votes', 'progress', 'notes', 'lineups', 'clips'] loop
    execute format('drop trigger if exists touch on public.%I', t);
    execute format('create trigger touch before insert or update on public.%I for each row execute function public.touch()', t);
  end loop;
end $$;

-- eigene Rechte im Team t (null = kein Mitglied); security definer, damit die Policies von members sich nicht selbst aufrufen
create or replace function public.my_perm(t uuid) returns text language sql stable security definer set search_path = public as $$
  select perm from public.members where team_id = t and user_id = auth.uid() and not deleted
$$;
create or replace function public.is_member(t uuid) returns boolean language sql stable security definer set search_path = public as $$
  select public.my_perm(t) is not null
$$;
create or replace function public.is_admin(t uuid) returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.my_perm(t) = 'admin', false)
$$;
create or replace function public.my_team() returns uuid language sql stable security definer set search_path = public as $$
  select team_id from public.members where user_id = auth.uid() and not deleted
$$;
create or replace function public.new_code() returns text language sql volatile as $$
  select upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))
$$;
create or replace function public.ms(ts timestamptz) returns bigint language sql immutable as $$
  select (extract(epoch from ts) * 1000)::bigint
$$;
-- Team-ID aus einem Speicherpfad <team>/…; null, wenn der Pfad nicht so aussieht
create or replace function public.storage_team(name text) returns uuid language sql immutable as $$
  select case when split_part(name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then split_part(name, '/', 1)::uuid end
$$;
-- belegter Speicher eines Teams (Clips + Bilder), nur für Mitglieder
create or replace function public.team_storage_bytes(t uuid) returns bigint language sql stable security definer set search_path = public, storage as $$
  select coalesce(sum((o.metadata ->> 'size')::bigint), 0)::bigint from storage.objects o
  where public.is_member(t) and o.bucket_id = 'clips' and o.name like t::text || '/%'
$$;
create or replace function public.team_limit() returns bigint language sql immutable as $$ select 800::bigint * 1024 * 1024 $$;

-- members: Spieler ändern nur Name/SteamID und dürfen austreten; Rechte/Rollen nur Admins; der letzte Admin bleibt
create or replace function public.members_guard() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.team_id <> old.team_id or new.user_id <> old.user_id then
    raise exception 'Members cannot be moved' using errcode = '42501';
  end if;
  if not public.is_admin(old.team_id) and ((new.perm, new.roles, new.joined_at) is distinct from (old.perm, old.roles, old.joined_at) or (old.deleted and not new.deleted)) then
    raise exception 'Only admins can change permissions or roles' using errcode = '42501';
  end if;
  if old.perm = 'admin' and not old.deleted and (new.perm <> 'admin' or new.deleted)
     and not exists (select 1 from public.members where team_id = old.team_id and user_id <> old.user_id and perm = 'admin' and not deleted)
     and exists (select 1 from public.members where team_id = old.team_id and user_id <> old.user_id and not deleted) then
    raise exception 'The last admin cannot leave or step down. Make someone else admin first.' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists guard on public.members;
create trigger guard before update on public.members for each row execute function public.members_guard();

-- Clip-Speicher: neuer/ersetzter Clip passt noch ins Team-Limit (der alte Clip zählt beim Ersetzen nicht mit)
create or replace function public.clips_quota() returns trigger language plpgsql security definer set search_path = public, storage as $$
declare old_path text; old_size bigint;
begin
  if new.deleted then return new; end if;
  -- auch beim Upsert (INSERT … ON CONFLICT) den vorhandenen Clip dieses Lineups abziehen
  select path into old_path from public.clips where lineup_id = new.lineup_id and not deleted;
  if old_path = new.path then return new; end if;
  select (metadata ->> 'size')::bigint into old_size from storage.objects where bucket_id = 'clips' and name = old_path;
  if public.team_storage_bytes(new.team_id) - coalesce(old_size, 0) + new.bytes > public.team_limit() then
    raise exception 'Team storage is full (800 MB). Delete old clips first.' using errcode = '53100';
  end if;
  return new;
end $$;
drop trigger if exists quota on public.clips;
create trigger quota before insert or update on public.clips for each row execute function public.clips_quota();

-- ---------------------------------------------------------------- Row Level Security

alter table public.teams enable row level security;
alter table public.team_invites enable row level security;
alter table public.members enable row level security;
alter table public.strats enable row level security;
alter table public.votes enable row level security;
alter table public.progress enable row level security;
alter table public.notes enable row level security;
alter table public.lineups enable row level security;
alter table public.clips enable row level security;

-- alte Policies dieses Skripts entfernen (Neuanlage unten)
do $$
declare p record;
begin
  for p in select policyname, tablename from pg_policies where schemaname = 'public' and policyname like 'csda_%' loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

-- Teams: anlegen nur per create_team; lesen Mitglieder, ändern Admins
create policy csda_teams_read on public.teams for select to authenticated using (public.is_member(id));
create policy csda_teams_edit on public.teams for update to authenticated using (public.is_admin(id)) with check (public.is_admin(id));

create policy csda_invites_read on public.team_invites for select to authenticated using (public.is_admin(team_id));

-- Mitglieder: Beitritt nur per RPC; eigenes Profil oder Admin (Trigger guard prüft, welche Felder)
create policy csda_members_read on public.members for select to authenticated using (public.is_member(team_id));
create policy csda_members_edit on public.members for update to authenticated
  using (user_id = auth.uid() or public.is_admin(team_id)) with check (user_id = auth.uid() or public.is_admin(team_id));

-- Strats: Spieler nur eigene Vorschläge; freigeben/ablehnen per RPC decide
create policy csda_strats_read on public.strats for select to authenticated using (public.is_member(team_id));
create policy csda_strats_add on public.strats for insert to authenticated with check (
  public.is_admin(team_id) or (public.is_member(team_id) and status = 'proposed' and author = auth.uid() and decided_by is null));
create policy csda_strats_edit on public.strats for update to authenticated
  using (public.is_admin(team_id) or (public.is_member(team_id) and author = auth.uid() and status = 'proposed'))
  with check (public.is_admin(team_id) or (public.is_member(team_id) and author = auth.uid() and status = 'proposed' and decided_by is null));

-- Stimmen: je Mitglied eine, nur die eigene, nur für Strats des eigenen Teams
create policy csda_votes_read on public.votes for select to authenticated using (public.is_member(team_id));
create policy csda_votes_add on public.votes for insert to authenticated with check (
  member_id = auth.uid() and public.is_member(team_id) and exists (select 1 from public.strats s where s.id = strat_id and s.team_id = votes.team_id));
create policy csda_votes_edit on public.votes for update to authenticated using (member_id = auth.uid())
  with check (member_id = auth.uid() and public.is_member(team_id) and exists (select 1 from public.strats s where s.id = strat_id and s.team_id = votes.team_id));

create policy csda_progress_read on public.progress for select to authenticated using (public.is_member(team_id));
create policy csda_progress_add on public.progress for insert to authenticated with check (member_id = auth.uid() and public.is_member(team_id));
create policy csda_progress_edit on public.progress for update to authenticated using (member_id = auth.uid())
  with check (member_id = auth.uid() and public.is_member(team_id));

create policy csda_notes_read on public.notes for select to authenticated using (public.is_member(team_id));
create policy csda_notes_add on public.notes for insert to authenticated with check (author = auth.uid() and public.is_member(team_id));
create policy csda_notes_edit on public.notes for update to authenticated
  using (public.is_admin(team_id) or (author = auth.uid() and public.is_member(team_id)))
  with check (public.is_admin(team_id) or (author = auth.uid() and public.is_member(team_id)));

-- Team-Lineups: jeder legt an, ändern/löschen eigene oder Admin
create policy csda_lineups_read on public.lineups for select to authenticated using (public.is_member(team_id));
create policy csda_lineups_add on public.lineups for insert to authenticated with check (created_by = auth.uid() and public.is_member(team_id));
create policy csda_lineups_edit on public.lineups for update to authenticated
  using (public.is_admin(team_id) or (created_by = auth.uid() and public.is_member(team_id)))
  with check (public.is_admin(team_id) or (created_by = auth.uid() and public.is_member(team_id)));

-- Clips: wer das Lineup ändern darf
create policy csda_clips_read on public.clips for select to authenticated using (public.is_member(team_id));
create policy csda_clips_add on public.clips for insert to authenticated with check (
  public.is_member(team_id) and exists (select 1 from public.lineups l where l.id = lineup_id and l.team_id = clips.team_id and (l.created_by = auth.uid() or public.is_admin(l.team_id))));
create policy csda_clips_edit on public.clips for update to authenticated
  using (public.is_member(team_id) and exists (select 1 from public.lineups l where l.id = lineup_id and (l.created_by = auth.uid() or public.is_admin(l.team_id))))
  with check (public.is_member(team_id) and exists (select 1 from public.lineups l where l.id = lineup_id and l.team_id = clips.team_id and (l.created_by = auth.uid() or public.is_admin(l.team_id))));

-- ---------------------------------------------------------------- RPCs

create or replace function public.create_team(team_name text, my_name text) returns uuid language plpgsql security definer set search_path = public as $$
declare t uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '28000'; end if;
  if public.my_team() is not null then raise exception 'You are already in a team. Leave it first.' using errcode = 'P0001'; end if;
  insert into public.teams (name) values (trim(team_name)) returning id into t;
  insert into public.members (team_id, user_id, name, perm) values (t, auth.uid(), trim(my_name), 'admin');
  insert into public.team_invites (team_id, code) values (t, public.new_code());
  return t;
end $$;

create or replace function public.join_team(invite text, my_name text) returns uuid language plpgsql security definer set search_path = public as $$
declare t uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '28000'; end if;
  select team_id into t from public.team_invites where code = upper(trim(invite));
  if t is null then raise exception 'Invite code not found' using errcode = 'P0002'; end if;
  if public.my_team() = t then return t; end if;
  if public.my_team() is not null then raise exception 'You are already in a team. Leave it first.' using errcode = 'P0001'; end if;
  delete from public.members where team_id = t and user_id = auth.uid(); -- früher ausgetreten/entfernt: neu als Spieler
  -- Team ohne aktiven Admin (alle ausgetreten): wer beitritt, wird Admin
  insert into public.members (team_id, user_id, name, perm) values (t, auth.uid(), trim(my_name),
    case when exists (select 1 from public.members where team_id = t and perm = 'admin' and not deleted) then 'player' else 'admin' end);
  return t;
end $$;

create or replace function public.leave_team() returns void language plpgsql security definer set search_path = public as $$
begin
  update public.members set deleted = true where user_id = auth.uid() and not deleted; -- Trigger guard: letzter Admin bleibt
end $$;

create or replace function public.new_invite_code() returns text language plpgsql security definer set search_path = public as $$
declare t uuid := public.my_team(); c text := public.new_code();
begin
  if not public.is_admin(t) then raise exception 'Only admins can create invite codes' using errcode = '42501'; end if;
  update public.team_invites set code = c where team_id = t;
  return c;
end $$;

-- Vorschlag freigeben (ok) oder ablehnen; Änderungsvorschlag (base_id) ersetzt dabei den Inhalt des Originals (Original-ID bleibt)
create or replace function public.decide(strat uuid, ok boolean) returns void language plpgsql security definer set search_path = public as $$
declare s public.strats;
begin
  select * into s from public.strats where id = strat and not deleted for update;
  if not found or not public.is_admin(s.team_id) then raise exception 'Only admins can approve or reject' using errcode = '42501'; end if;
  if s.status <> 'proposed' then raise exception 'This strat is not an open proposal' using errcode = 'P0001'; end if;
  if ok and s.base_id is not null then
    -- decided_by des Originals bleibt (sonst stünde es unter „Entschieden“ wie ein eigener Vorschlag)
    update public.strats set data = s.data, status = 'approved' where id = s.base_id and team_id = s.team_id and not deleted;
    if not found then raise exception 'The original strat no longer exists' using errcode = 'P0002'; end if;
  end if;
  update public.strats set status = case when ok then 'approved' else 'rejected' end, decided_by = auth.uid() where id = s.id;
end $$;

-- Änderungen seit since (null = alles) im Format der App (src/shared/team.ts); läuft mit den Rechten des Aufrufers (RLS)
create or replace function public.sync(since timestamptz default null) returns jsonb language plpgsql stable set search_path = public as $$
declare t uuid := public.my_team(); s timestamptz := coalesce(since, '-infinity');
begin
  if t is null then return jsonb_build_object('now', now(), 'team', null); end if;
  return jsonb_build_object(
    'now', now(),
    'team', (select jsonb_strip_nulls(jsonb_build_object('id', id, 'name', name, 'mapPool', map_pool, 'focus', focus, 'updatedAt', public.ms(updated_at)))
             from public.teams where id = t),
    'invite', (select code from public.team_invites where team_id = t and updated_at > s),
    'members', (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', user_id, 'teamId', team_id, 'name', name, 'steamid', steamid,
               'perm', perm, 'roles', to_jsonb(roles), 'joinedAt', public.ms(joined_at), 'updatedAt', public.ms(updated_at), 'deleted', deleted))), '[]')
               from public.members where team_id = t and updated_at > s),
    'strats', (select coalesce(jsonb_agg(jsonb_strip_nulls(data || jsonb_build_object('id', id, 'teamId', team_id, 'author', author, 'status', status,
               'baseId', base_id, 'decidedBy', decided_by, 'createdAt', public.ms(created_at), 'updatedAt', public.ms(updated_at), 'deleted', deleted))), '[]')
               from public.strats where team_id = t and updated_at > s),
    'votes', (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('stratId', strat_id, 'memberId', member_id, 'value', value,
              'comment', comment, 'updatedAt', public.ms(updated_at)))), '[]') from public.votes where team_id = t and updated_at > s),
    'progress', (select coalesce(jsonb_agg(jsonb_build_object('memberId', member_id, 'ref', jsonb_build_object(ref_kind, ref_id), 'status', status,
                 'updatedAt', public.ms(updated_at))), '[]') from public.progress where team_id = t and updated_at > s),
    'notes', (select coalesce(jsonb_agg(jsonb_strip_nulls(data || jsonb_build_object('id', id, 'teamId', team_id, 'author', author,
              'updatedAt', public.ms(updated_at), 'deleted', deleted))), '[]') from public.notes where team_id = t and updated_at > s),
    'lineups', (select coalesce(jsonb_agg(jsonb_strip_nulls(data || jsonb_build_object('id', id, 'owner', jsonb_build_object('team', team_id),
                'createdBy', created_by, 'updatedAt', public.ms(updated_at), 'deleted', deleted))), '[]') from public.lineups where team_id = t and updated_at > s),
    'clips', (select coalesce(jsonb_agg(jsonb_build_object('lineupId', lineup_id, 'path', path, 'bytes', bytes, 'durationS', duration_s,
              'updatedAt', public.ms(updated_at), 'deleted', deleted)), '[]') from public.clips where team_id = t and updated_at > s)
  );
end $$;

create or replace function public.team_storage() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('bytes', public.team_storage_bytes(public.my_team()), 'limit', public.team_limit())
$$;

-- nur angemeldete Nutzer (auch anonyme) dürfen die RPCs aufrufen
do $$
declare f text;
begin
  foreach f in array array['create_team(text, text)', 'join_team(text, text)', 'leave_team()', 'new_invite_code()', 'decide(uuid, boolean)',
                           'sync(timestamptz)', 'team_storage()', 'my_perm(uuid)', 'is_member(uuid)', 'is_admin(uuid)', 'my_team()', 'team_storage_bytes(uuid)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- ---------------------------------------------------------------- Speicher (Bucket „clips“, privat)

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('clips', 'clips', false, 16777216, array['video/webm', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = 16777216, allowed_mime_types = array['video/webm', 'image/webp'];

drop policy if exists "csda clips read" on storage.objects;
drop policy if exists "csda clips upload" on storage.objects;
drop policy if exists "csda clips delete" on storage.objects;
create policy "csda clips read" on storage.objects for select to authenticated
  using (bucket_id = 'clips' and public.is_member(public.storage_team(name)));
-- Hochladen: Mitglied, Team unter dem Limit; Clips nur mit vorher angelegtem clips-Eintrag (Größe geprüft), Bilder nur als <sha1>.webp
create policy "csda clips upload" on storage.objects for insert to authenticated with check (
  bucket_id = 'clips' and public.is_member(public.storage_team(name))
  and public.team_storage_bytes(public.storage_team(name)) < public.team_limit()
  and (name ~ '^[0-9a-f-]{36}/img/[0-9a-f]{40}\.webp$'
       or (name ~ '^[0-9a-f-]{36}/clip/[0-9a-f-]{36}\.webm$' and exists (select 1 from public.clips c where c.path = name and c.team_id = public.storage_team(name)))));
create policy "csda clips delete" on storage.objects for delete to authenticated using (
  bucket_id = 'clips' and name ~ '^[0-9a-f-]{36}/clip/' and (public.is_admin(public.storage_team(name)) or (owner_id = auth.uid()::text and public.is_member(public.storage_team(name)))));
