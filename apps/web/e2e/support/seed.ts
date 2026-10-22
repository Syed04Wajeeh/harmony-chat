import { DevApi } from './dev-api.js';
import { scenePng } from './png.js';

export const PEOPLE = ['ada', 'linus', 'grace', 'margaret', 'alan'] as const;
export type Person = (typeof PEOPLE)[number];

export interface Seeded {
  api: Record<Person, DevApi>;
  ids: Record<Person, string>;
  guildId: string;
  inviteCode: string;
  channels: Record<'general' | 'recommendations' | 'bookNook' | 'offTopic', string>;
  dmId: string;
  pinnedId: string;
  imageMessageId: string;
  replyMessageId: string;
}

const fakePdf = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

/** A fictional book club with a day's worth of conversation. Ada is the viewer. */
export async function seedBookClub(baseUrl: string): Promise<Seeded> {
  const api = Object.fromEntries(
    PEOPLE.map((name) => [name, new DevApi(baseUrl, `${name}@example.com`)]),
  ) as Record<Person, DevApi>;

  const ids = {} as Record<Person, string>;
  for (const name of PEOPLE) ids[name] = (await api[name].me()).id;

  const guild = await api.ada.createGuild('Book Club');
  const invite = await api.ada.createInvite(guild.id);
  for (const name of ['linus', 'grace', 'margaret', 'alan'] as const)
    await api[name].acceptInvite(invite.code);

  const list = await api.ada.channels();
  const general = list.find((c) => c.guildId === guild.id && c.name === 'general');
  if (!general) throw new Error('general channel missing');
  const recommendations = await api.ada.createChannel(guild.id, 'recommendations', {
    topic: 'What are you reading? Keep spoilers out of here.',
  });
  const bookNook = await api.ada.createChannel(guild.id, 'book-nook', {
    topic: 'Quiet corner for the people who have finished the book.',
    isPrivate: true,
  });
  const offTopic = await api.ada.createChannel(guild.id, 'off-topic');
  for (const name of ['grace', 'linus'] as const)
    await api.ada.addChannelMember(bookNook.id, ids[name]);

  const g = general.id;
  await api.grace.send(g, 'Morning everyone! Reminder that we pick the next book on Friday.');
  const short = await api.linus.send(
    g,
    "I vote for something short this time. Last month's 900 pages nearly broke me 😅",
  );
  await api.ada.send(
    g,
    'Agreed. My shortlist: **Piranesi**, *The Left Hand of Darkness* and `Klara and the Sun`.',
  );
  const shortlist = await api.ada.send(g, 'Anyone read any of them already?');
  const reply = await api.margaret.send(
    g,
    'Piranesi is wonderful. Go in blind if you can, the less you know the better.',
    {
      replyToId: shortlist.id,
    },
  );
  await api.alan.send(g, '> Short books, long conversations.\nThat should be our motto.');
  const photo = await api.linus.upload('second-hand-shop.png', scenePng(1200, 800));
  const image = await api.linus.send(g, 'Found this beauty at the second-hand shop today', {
    attachmentIds: [photo.id],
  });
  await api.alan.send(
    g,
    'Here is the snippet I use to track our reading list:\n```ts\nconst books = ["Piranesi", "Klara and the Sun"];\nconsole.log(`${books.length} candidates`);\n```',
  );
  const pdf = await api.grace.upload('reading-list-2026.pdf', fakePdf, 'application/pdf');
  const pinned = await api.grace.send(
    g,
    'Meeting is **Friday 7pm** at the usual café. Bring snacks! 🍪',
    {
      attachmentIds: [pdf.id],
    },
  );
  await api.ada.pin(pinned.id);

  const slip = await api.alan.send(g, 'oops wrong channel');
  await api.alan.remove(slip.id);

  for (const [who, emoji] of [
    ['ada', '👍'],
    ['linus', '👍'],
    ['grace', '👍'],
    ['margaret', '😂'],
    ['ada', '😂'],
  ] as const) {
    await api[who].react(short.id, emoji);
  }
  for (const who of ['ada', 'linus', 'alan'] as const) await api[who].react(reply.id, '❤️');
  await api.margaret.react(reply.id, '🎉');
  await api.ada.react(image.id, '😍');
  await api.grace.react(image.id, '🔥');
  await api.grace.react(pinned.id, '🎉');

  // Ada is caught up here; everything after this point is new for her.
  const caughtUp = await api.alan.send(g, 'Last call for book suggestions before Friday.');
  await api.ada.markRead(g, caughtUp.id);

  await api.linus.send(g, `<@${ids.ada}> are you bringing the spreadsheet on Friday?`);
  await api.grace.send(
    g,
    'Also, I just finished chapter 3 and *wow*. No spoilers please! ~~mostly~~',
  );
  const edited = await api.margaret.send(g, 'Hot take: the **ending** is the best part, fight me');
  await api.margaret.edit(
    edited.id,
    'Hot take: the **ending** is the best part, fight me. (Kidding, mostly.)',
  );

  await api.grace.send(
    recommendations.id,
    `<@${ids.ada}> have you tried *The Remains of the Day*? It is short, quiet and devastating.`,
  );
  await api.linus.send(recommendations.id, 'Adding **Station Eleven** to the pile.');
  await api.margaret.send(offTopic.id, 'Does anyone know a good bookbinder?');

  const dm = await api.grace.openDm(ids.ada);
  await api.grace.send(dm.id, 'Hey, could you send me the spreadsheet before Friday?');

  return {
    api,
    ids,
    guildId: guild.id,
    inviteCode: invite.code,
    channels: {
      general: general.id,
      recommendations: recommendations.id,
      bookNook: bookNook.id,
      offTopic: offTopic.id,
    },
    dmId: dm.id,
    pinnedId: pinned.id,
    imageMessageId: image.id,
    replyMessageId: reply.id,
  };
}
