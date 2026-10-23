#!/usr/bin/env bash
# EXPLAIN (ANALYZE, BUFFERS) of the unread subquery for one user, in the harmony-load database.
#   unread-explain.sh old|new [login]
set -euo pipefail
variant="$1"; login="${2:-load-cap-0@example.com}"
psql_() { docker exec -i harmony-load-postgres-1 psql -U harmony -d harmony "$@"; }
uid="$(psql_ -Atc "select id from users where login='$login'")"
if [ "$variant" = old ]; then
  sub="(select count(*)::int from (select 1 from messages m where m.channel_id = c.id and m.id > coalesce(cm.last_read_message_id, 0) and m.author_id <> $uid and m.deleted_at is null limit 101) unread)"
  from="channel_members cm join channels c on c.id = cm.channel_id where cm.user_id = $uid and c.archived_at is null"
  q="select c.id, $sub as unread_count from $from"
else
  from="channel_members cm join channels c on c.id = cm.channel_id cross join lateral (select count(*)::int as n from (select 1 from messages m where m.channel_id = c.id and m.id > coalesce(cm.last_read_message_id, 0) and m.author_id <> $uid and m.deleted_at is null order by m.id limit 101) x) unread where cm.user_id = $uid and c.archived_at is null"
  q="select c.id, unread.n from $from"
fi
psql_ -c "explain (analyze, buffers) $q" | cut -c1-190
