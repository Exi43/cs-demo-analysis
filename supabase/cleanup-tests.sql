-- CS Demo Analysis: Testdaten der QA-Läufe entfernen. Einmal komplett im SQL-Editor ausführen; mehrfach ausführen schadet nicht.
-- Löscht alle Teams mit Namen „zz-…“ samt allem, was daran hängt (on delete cascade in team.sql: team_invites, members, strats,
-- votes, progress, notes, lineups, clips) und anonyme Test-Nutzer vom 28.10.2026, die in keinem Team (mehr) aktiv sind.
-- Storage-Dateien (Bucket „clips“) löscht Supabase nicht per SQL: die Abfrage am Ende listet die verwaisten Dateien; deren Ordner
-- (= alte Team-ID) im Dashboard unter Storage → clips von Hand löschen.

begin;

delete from public.teams where name like 'zz-%';

delete from auth.users u
where u.is_anonymous
  and u.created_at >= timestamptz '2026-10-28 00:00:00 Europe/Berlin'
  and u.created_at <= now()
  and not exists (select 1 from public.members m where m.user_id = u.id and not m.deleted);

commit;

-- verwaiste Storage-Dateien (Ordner eines Teams, das es nicht mehr gibt)
select split_part(o.name, '/', 1) as team_folder, o.name, (o.metadata ->> 'size')::bigint as bytes
from storage.objects o
where o.bucket_id = 'clips'
  and not exists (select 1 from public.teams t where t.id::text = split_part(o.name, '/', 1))
order by o.name;
