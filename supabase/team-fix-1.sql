-- Nachtrag 1 zu team.sql (einmal im SQL-Editor ausführen; mehrfach schadet nicht). team.sql enthält die Änderung schon.
-- Freigabe eines Änderungsvorschlags setzte decided_by auch beim Original: das Original stand dann unter „Proposals → Decided“
-- wie ein eigener Vorschlag. Jetzt bleibt decided_by des Originals unverändert.
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

revoke execute on function public.decide(uuid, boolean) from public, anon;
grant execute on function public.decide(uuid, boolean) to authenticated;


-- Verlässt das letzte Mitglied ein Team, gibt es keinen Admin mehr: wer danach mit dem Code beitritt, wird Admin.
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


