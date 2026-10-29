-- Since migration 0018 new users join no guild unless an admin sets a lobby, so this is only needed
-- for databases seeded before that (or with a lobby set).
-- Every user is auto-joined to the default guild on first contact, which would make the world one
-- giant shared guild. This removes the load users (all but the guild's owner, load-cap-0, who
-- created it) from it, leaving each user only in their own 100-member guild. Restart the app
-- containers afterwards: they cache guild membership.
--   docker exec -i harmony-load-postgres-1 psql -U harmony -d harmony -v ON_ERROR_STOP=1 < loadtest/scripts/detach-default-guild.sql
begin;
create temp table load_users as
  select u.id from users u, guilds g
  where g.is_default and u.login like 'load-%@example.com' and u.id <> g.owner_id;
delete from channel_members cm using channels c, guilds g
  where g.is_default and c.guild_id = g.id and cm.channel_id = c.id
    and cm.user_id in (select id from load_users);
delete from member_roles mr using guilds g
  where g.is_default and mr.guild_id = g.id and mr.user_id in (select id from load_users);
delete from guild_members gm using guilds g
  where g.is_default and gm.guild_id = g.id and gm.user_id in (select id from load_users);
commit;
select (select count(*) from guild_members gm join guilds g on g.id = gm.guild_id where g.is_default) as default_guild_members,
       (select count(*) from guild_members) as total_memberships;
