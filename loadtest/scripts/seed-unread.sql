-- Seeds the "inactive channel in a busy database" shape that makes the unread subquery slow.
-- 599,998 rows (3 x 199,666 + 1,000). Run against the cap world (100 guilds x 100 users, one `general` channel each; user
-- load-cap-0 owns guild 0). Channel 0 gets 1,000 early messages from another member and
-- load-cap-0 has read all but the last 5; the other 99 channels then get 599,000 messages, so
-- every id after load-cap-0's read marker belongs to some other channel. The 599,000 rows go to
-- only 3 busy channels (a few busy channels and many quiet ones, like a real small server), which
-- is what makes the planner expect a channel to be dense in the primary key and walk it.
--   docker exec -i harmony-load-postgres-1 psql -U harmony -d harmony -v ON_ERROR_STOP=1 < loadtest/scripts/seed-unread.sql
begin;
create temp table chans as
  select c.id as channel_id, g.owner_id, row_number() over (order by g.id) as n
  from channels c join guilds g on g.id = c.guild_id join users u on u.id = g.owner_id
  where c.kind = 'text' and c.name = 'general' and u.login like 'load-cap-%@example.com'
  order by g.id;
insert into messages (channel_id, author_id, content)
  select (select channel_id from chans where n = 1),
         (select id from users where login = 'load-cap-1@example.com'),
         'early message ' || i
  from generate_series(1, 1000) i;
update channel_members cm
  set last_read_message_id = (select max(id) - 5 from messages
                              where channel_id = (select channel_id from chans where n = 1))
  where cm.channel_id = (select channel_id from chans where n = 1)
    and cm.user_id = (select id from users where login = 'load-cap-0@example.com');
insert into messages (channel_id, author_id, content)
  select ch.channel_id, ch.owner_id, 'seed ' || i
  from chans ch, generate_series(1, 199666) i
  where ch.n between 2 and 4;
commit;
analyze messages;
select count(*) as messages from messages;
