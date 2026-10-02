/**
 * AENEWS SOUND — seed runtime (données strictement nécessaires au fonctionnement
 * + catalogue de démonstration avec de VRAIS fichiers audio WAV générés).
 *
 * Exécution : bun prisma/seed.ts
 *
 * Contenu :
 *  - Comptes : admin (+243000000001 / admin-aenews-2024),
 *              artiste (+243000000002 / artiste-aenews-2024),
 *              écouteur démo (+243000000003 / ecoute-aenews-2024)
 *  - Provider SANDBOX (adaptateur de l'interface agrégateur mobile money)
 *  - Packs prépayés (24h / 7j / 30j en CDF), genres, territoires, feature flags
 *  - 2 artistes, 2 albums, 8 titres (6 publiés, 2 en modération) avec :
 *    masters WAV + variante PROGRESSIVE + waveform JSON + artwork SVG réels
 *  - Droits OWNERSHIP actifs, méthode de payout mobile money, période de royaltie ouverte
 */
import { PrismaClient } from "@prisma/client";
import crypto from "crypto";
import { putObject, putJsonObject } from "../src/lib/storage";
import { hashPassword } from "../src/lib/auth";
import { audit } from "../src/lib/audit";

const db = new PrismaClient();
const SAMPLE_RATE = 22050;

// ---------------------------------------------------------------------------
// Générateurs déterministes : WAV PCM 16 bits mono + peaks + artwork SVG
// ---------------------------------------------------------------------------

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function wrapWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function generatePcm(durationSeconds: number, baseFreqs: number[], seed: number): Buffer {
  const numSamples = SAMPLE_RATE * durationSeconds;
  const pcm = Buffer.alloc(numSamples * 2);
  const barSeconds = 2;
  const rand = mulberry(seed);
  const phase = rand() * Math.PI * 2;
  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    const bar = Math.floor(t / barSeconds);
    const freq = baseFreqs[(bar + seed) % baseFreqs.length];
    const pulse = Math.abs(Math.sin(2 * Math.PI * (t % 0.5) / 0.5)); // pulsation 120 BPM
    const barEnv = 0.55 + 0.45 * Math.abs(Math.sin((Math.PI * (t % barSeconds)) / barSeconds));
    const envelope = Math.min(1, t * 3, Math.max(0, durationSeconds - t) * 2);
    let sample =
      Math.sin(2 * Math.PI * freq * t + phase) * 0.42 +
      Math.sin(2 * Math.PI * freq * 1.5 * t + 0.3) * 0.18 +
      Math.sin(2 * Math.PI * freq * 2 * t + 1.1) * 0.1 +
      Math.sin(2 * Math.PI * 55 * t) * 0.22 * pulse;
    sample *= envelope * barEnv;
    const value = Math.max(-32767, Math.min(32767, Math.round(sample * 32767 * 0.72)));
    pcm.writeInt16LE(value, i * 2);
  }
  return pcm;
}

function computePeaks(pcm: Buffer, buckets = 400): number[] {
  const samples = pcm.length / 2;
  const per = Math.max(1, Math.floor(samples / buckets));
  const peaks: number[] = [];
  for (let b = 0; b < buckets; b++) {
    let max = 0;
    const start = b * per;
    const end = Math.min((b + 1) * per, samples);
    for (let i = start; i < end; i++) {
      const v = Math.abs(pcm.readInt16LE(i * 2));
      if (v > max) max = v;
    }
    peaks.push(Number((max / 32767).toFixed(3)));
  }
  return peaks;
}

const PALETTES = [
  ["#f59e0b", "#78350f"],
  ["#10b981", "#064e3b"],
  ["#f43f5e", "#881337"],
  ["#a855f7", "#581c87"],
  ["#14b8a6", "#134e4a"],
  ["#f97316", "#7c2d12"],
  ["#84cc16", "#365314"],
  ["#e11d48", "#4c0519"],
];

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function artworkSvg(initials: string, title: string, subtitle: string, index: number): Buffer {
  const [c1, c2] = PALETTES[index % PALETTES.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/>
  </linearGradient></defs>
  <rect width="512" height="512" fill="url(#g)"/>
  <circle cx="256" cy="210" r="120" fill="rgba(255,255,255,0.12)"/>
  <text x="256" y="252" font-family="system-ui, sans-serif" font-size="96" font-weight="800"
        fill="rgba(255,255,255,0.92)" text-anchor="middle">${escapeXml(initials)}</text>
  <text x="256" y="392" font-family="system-ui, sans-serif" font-size="34" font-weight="700"
        fill="#ffffff" text-anchor="middle">${escapeXml(title.slice(0, 22))}</text>
  <text x="256" y="432" font-family="system-ui, sans-serif" font-size="24"
        fill="rgba(255,255,255,0.75)" text-anchor="middle">${escapeXml(subtitle.slice(0, 28))}</text>
</svg>`;
  return Buffer.from(svg, "utf-8");
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

const TRACKS = [
  { title: "Formule Kino", artist: "koffi-nazenga", album: "formule-kino", duration: 34, freqs: [220, 262, 294, 330], status: "PUBLISHED", genres: ["Rumba", "Ndombolo"] },
  { title: "Ligne de Bus", artist: "koffi-nazenga", album: "formule-kino", duration: 28, freqs: [196, 247, 294], status: "PUBLISHED", genres: ["Rumba"] },
  { title: "Marché Gambela", artist: "koffi-nazenga", album: "formule-kino", duration: 40, freqs: [233, 277, 311, 349], status: "PUBLISHED", genres: ["Soukous"] },
  { title: "Poids Lourd", artist: "koffi-nazenga", album: "formule-kino", duration: 26, freqs: [175, 220, 262], status: "PUBLISHED", genres: ["Ndombolo"] },
  { title: "Kino By Night", artist: "koffi-nazenga", album: "formule-kino", duration: 38, freqs: [208, 247, 311], status: "PENDING_REVIEW", genres: ["Afrobeat"] },
  { title: "Lumière de Léo", artist: "nadia-mbombo", album: "lumiere-de-leo", duration: 32, freqs: [262, 330, 392], status: "PUBLISHED", genres: ["Gospel"] },
  { title: "Espoir Matin", artist: "nadia-mbombo", album: "lumiere-de-leo", duration: 30, freqs: [294, 349, 440], status: "PUBLISHED", genres: ["Gospel", "Rumba"] },
  { title: "Refrain du Fleuve", artist: "nadia-mbombo", album: "lumiere-de-leo", duration: 36, freqs: [247, 311, 370], status: "PENDING_REVIEW", genres: ["Rumba"] },
];

async function main() {
  console.log("→ Seed AENEWS SOUND…");

  // 1. Comptes ---------------------------------------------------------------
  const admin = await db.user.upsert({
    where: { phone: "+243000000001" },
    update: {},
    create: {
      phone: "+243000000001",
      displayName: "Admin AENEWS",
      passwordHash: hashPassword("admin-aenews-2024"),
      role: "SUPER_ADMIN",
      locale: "fr",
      country: "CD",
    },
  });
  const artistUser = await db.user.upsert({
    where: { phone: "+243000000002" },
    update: {},
    create: {
      phone: "+243000000002",
      displayName: "Koffi Nazenga",
      passwordHash: hashPassword("artiste-aenews-2024"),
      role: "ARTIST",
      locale: "fr",
      country: "CD",
    },
  });
  const listener = await db.user.upsert({
    where: { phone: "+243000000003" },
    update: {},
    create: {
      phone: "+243000000003",
      displayName: "Écouteur Démo",
      passwordHash: hashPassword("ecoute-aenews-2024"),
      role: "USER",
      locale: "fr",
      country: "CD",
    },
  });

  // 2. Provider + packs + genres + territoires + flags ------------------------
  const sandbox = await db.paymentProvider.upsert({
    where: { code: "SANDBOX" },
    update: {},
    create: {
      code: "SANDBOX",
      displayName: "Passerelle Sandbox (interface agrégateur mobile money)",
      isActive: true,
      testMode: true,
    },
  });
  void sandbox;

  for (const plan of [
    { code: "PACK_24H", name: "Pack Journée", description: "24 heures de streaming + downloads", durationHours: 24, priceMinor: BigInt(500) },
    { code: "PACK_7D", name: "Pack Semaine", description: "7 jours de streaming + downloads", durationHours: 168, priceMinor: BigInt(2500) },
    { code: "PACK_30D", name: "Pack Mois", description: "30 jours de streaming + downloads", durationHours: 720, priceMinor: BigInt(8000) },
  ]) {
    await db.subscriptionPlan.upsert({
      where: { code: plan.code },
      update: {},
      create: {
        ...plan,
        currency: "CDF",
        offlineDownloadLimit: 100,
        maxDevices: 2,
        features: JSON.stringify({ offline: true, quality: "256k", deviceSync: true }),
        sortOrder: plan.durationHours,
      },
    });
  }

  for (const name of ["Rumba", "Ndombolo", "Soukous", "Afrobeat", "Gospel", "Jazz Kino"]) {
    await db.genre.upsert({
      where: { name },
      update: {},
      create: { name, slug: slugify(name) },
    });
  }

  for (const [code, name] of [["CD", "RD Congo"], ["CG", "Congo"], ["FR", "France"], ["BE", "Belgique"], ["US", "États-Unis"]] as const) {
    await db.territory.upsert({ where: { code }, update: {}, create: { code, name } });
  }

  for (const flag of [
    { key: "premium_downloads_enabled", description: "Autorise les téléchargements offline premium", enabled: true },
    { key: "data_saver_default", description: "Mode économie de données activé par défaut", enabled: false },
    { key: "artist_studio_uploads", description: "Upload direct dans le Studio artiste", enabled: false },
  ]) {
    await db.featureFlag.upsert({ where: { key: flag.key }, update: {}, create: flag });
  }

  // 3. Payout method artiste --------------------------------------------------
  const existingMethod = await db.payoutMethod.findFirst({
    where: { userId: artistUser.id, type: "MOBILE_MONEY" },
  });
  if (!existingMethod) {
    await db.payoutMethod.create({
      data: {
        userId: artistUser.id,
        type: "MOBILE_MONEY",
        mmProvider: "VODACOM_MPESA",
        phoneNumber: "+243000000002",
        holderName: "Koffi Nazenga",
        isDefault: true,
        verifiedAt: new Date(),
      },
    });
  }

  // 4. Période de royaltie du mois courant ------------------------------------
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  await db.royaltyPeriod.upsert({
    where: { periodStart_periodEnd: { periodStart, periodEnd } },
    update: {},
    create: { periodStart, periodEnd, status: "OPEN" },
  });

  // 5. Artistes / albums / tracks / médias ------------------------------------
  const artistDefs = [
    {
      slug: "koffi-nazenga",
      name: "Koffi Nazenga",
      userId: artistUser.id,
      bio: "Guitariste-rhythmeur de Kinshasa, entre rumba congolaise moderne et ndombolo.",
      shareBps: 7000,
    },
    {
      slug: "nadia-mbombo",
      name: "Nadia Mbombo",
      userId: null,
      bio: "Chanteuse gospel de Lubumbashi, voix lead du chœur Lumière.",
      shareBps: 10000,
    },
  ];

  const artistIds: Record<string, string> = {};
  for (const def of artistDefs) {
    const initials = def.name.split(" ").map((w) => w[0]).join("").slice(0, 2);
    const artist = await db.artist.upsert({
      where: { slug: def.slug },
      update: {},
      create: { name: def.name, slug: def.slug, status: "ACTIVE", verifiedAt: new Date() },
    });
    artistIds[def.slug] = artist.id;

    const existingProfile = await db.artistProfile.findUnique({ where: { artistId: artist.id } });
    if (!existingProfile) {
      await db.artistProfile.create({
        data: { artistId: artist.id, bio: def.bio, socials: JSON.stringify({ whatsapp: "+243…" }) },
      });
    }

    const existingMember = await db.artistMember.findFirst({ where: { artistId: artist.id, memberName: def.name } });
    if (!existingMember) {
      await db.artistMember.create({
        data: {
          artistId: artist.id,
          userId: def.userId,
          memberName: def.name,
          role: "LEAD",
          shareBps: def.shareBps,
        },
      });
    }
    // Second membre (groupe) pour exercer le split — externe, sans compte.
    const secondName = `${def.name} & Groupe`;
    const existingSecond = await db.artistMember.findFirst({ where: { artistId: artist.id, memberName: secondName } });
    if (!existingSecond && def.shareBps === 7000) {
      await db.artistMember.create({
        data: { artistId: artist.id, memberName: secondName, role: "GUITAR", shareBps: 3000 },
      });
    }

    const artwork = artworkSvg(initials, def.name, "AENEWS SOUND", artistDefs.indexOf(def));
    putObject(`artwork/ARTIST/${artist.id}.svg`, artwork);
    const existingArtistArt = await db.artwork.findFirst({
      where: { ownerType: "ARTIST", ownerId: artist.id, isPrimary: true },
    });
    if (!existingArtistArt) {
      await db.artwork.create({
        data: { ownerType: "ARTIST", ownerId: artist.id, storageKey: `artwork/ARTIST/${artist.id}.svg`, width: 512, height: 512, isPrimary: true },
      });
    }
  }

  const albums: Record<string, string> = {};
  for (const [i, def] of [
    { slug: "formule-kino", title: "Formule Kino", artistSlug: "koffi-nazenga", type: "ALBUM", release: "2025-11-14" },
    { slug: "lumiere-de-leo", title: "Lumière de Léo", artistSlug: "nadia-mbombo", type: "EP", release: "2025-12-05" },
  ].entries()) {
    const artistId = artistIds[def.artistSlug];
    const album = await db.album.upsert({
      where: { slug: def.slug },
      update: {},
      create: {
        artistId,
        title: def.title,
        slug: def.slug,
        type: def.type,
        releaseDate: new Date(def.release),
        status: "PUBLISHED",
        publishedAt: new Date(def.release),
        description: `Catalogue de démonstration AENEWS SOUND — ${def.title}.`,
      },
    });
    albums[def.slug] = album.id;
    putObject(
      `artwork/ALBUM/${album.id}.svg`,
      artworkSvg(def.title.slice(0, 2).toUpperCase(), def.title, def.title, i + 2)
    );
    const existingAlbumArt = await db.artwork.findFirst({
      where: { ownerType: "ALBUM", ownerId: album.id, isPrimary: true },
    });
    if (!existingAlbumArt) {
      await db.artwork.create({
        data: { ownerType: "ALBUM", ownerId: album.id, storageKey: `artwork/ALBUM/${album.id}.svg`, width: 512, height: 512, isPrimary: true },
      });
    }
  }

  let trackIndex = 0;
  for (const def of TRACKS) {
    trackIndex += 1;
    const artistId = artistIds[def.artist];
    const albumId = albums[def.album];
    const slug = slugify(def.title);
    const track = await db.track.upsert({
      where: { slug },
      update: { status: def.status },
      create: {
        mainArtistId: artistId,
        albumId,
        title: def.title,
        slug,
        trackNumber: trackIndex,
        durationSeconds: def.duration,
        status: def.status,
        publishedAt: def.status === "PUBLISHED" ? new Date(Date.now() - (9 - trackIndex) * 86400000) : null,
      },
    });

    for (const genreName of def.genres) {
      const genre = await db.genre.findUnique({ where: { name: genreName } });
      if (genre) {
        await db.trackGenre.upsert({
          where: { trackId_genreId: { trackId: track.id, genreId: genre.id } },
          update: {},
          create: { trackId: track.id, genreId: genre.id },
        });
      }
    }

    await db.right.upsert({
      where: { id: `right-${track.id}`.slice(0, 25) + track.id.slice(-10) },
      update: {},
      create: {
        id: `right-${track.id}`.slice(0, 25) + track.id.slice(-10),
        trackId: track.id,
        holderArtistId: artistId,
        kind: "OWNERSHIP",
        streamingAllowed: true,
        downloadAllowed: true,
        status: def.status === "PUBLISHED" ? "ACTIVE" : "DRAFT",
      },
    });

    // Médias réels : master WAV + variante progressive + waveform + artwork.
    const pcm = generatePcm(def.duration, def.freqs, trackIndex * 131);
    const wav = wrapWav(pcm, SAMPLE_RATE);
    const master = putObject(`masters/${track.id}/master.wav`, wav);
    putObject(`audio/${track.id}/progressive.wav`, wav);
    putJsonObject(`waveform/${track.id}.json`, {
      trackId: track.id,
      sampleRate: SAMPLE_RATE,
      durationSeconds: def.duration,
      buckets: 400,
      peaks: computePeaks(pcm),
    });
    putObject(
      `artwork/TRACK/${track.id}.svg`,
      artworkSvg(def.title.slice(0, 2).toUpperCase(), def.title, def.title, trackIndex + 3)
    );

    const existingAsset = await db.audioAsset.findFirst({
      where: { trackId: track.id, kind: "MASTER" },
    });
    const asset =
      existingAsset ??
      (await db.audioAsset.create({
        data: {
          trackId: track.id,
          kind: "MASTER",
          storageKey: master.key,
          originalFilename: `${slug}.wav`,
          mimeType: "audio/wav",
          sizeBytes: BigInt(wav.length),
          sha256: master.sha256,
          durationSeconds: def.duration,
          sampleRate: SAMPLE_RATE,
          loudnessLufs: -14.0,
          metadata: JSON.stringify({ generated: "seed", note: "WAV PCM master — production : upload artiste réel" }),
          status: "READY",
          uploadedById: artistUser.id,
        },
      }));

    const progressive = await db.mediaVariant.upsert({
      where: { assetId_kind: { assetId: asset.id, kind: "PROGRESSIVE_128K" } },
      update: { status: "READY", readyAt: new Date(), storageKey: `audio/${track.id}/progressive.wav`, sizeBytes: BigInt(wav.length) },
      create: {
        assetId: asset.id,
        kind: "PROGRESSIVE_128K",
        codec: "PCM",
        deliveryFormat: "PROGRESSIVE",
        storageKey: `audio/${track.id}/progressive.wav`,
        sizeBytes: BigInt(wav.length),
        status: "READY",
        readyAt: new Date(),
      },
    });
    void progressive;

    await db.mediaVariant.upsert({
      where: { assetId_kind: { assetId: asset.id, kind: "WAVEFORM" } },
      update: { status: "READY", readyAt: new Date(), storageKey: `waveform/${track.id}.json` },
      create: {
        assetId: asset.id,
        kind: "WAVEFORM",
        codec: "PCM",
        deliveryFormat: "WAVEFORM_JSON",
        storageKey: `waveform/${track.id}.json`,
        status: "READY",
        readyAt: new Date(),
      },
    });

    const existingTrackArt = await db.artwork.findFirst({
      where: { ownerType: "TRACK", ownerId: track.id, isPrimary: true },
    });
    if (!existingTrackArt) {
      await db.artwork.create({
        data: { ownerType: "TRACK", ownerId: track.id, storageKey: `artwork/TRACK/${track.id}.svg`, width: 512, height: 512, isPrimary: true },
      });
    }

    // Les 2 titres en attente ont un rapport de modération système à traiter.
    if (def.status === "PENDING_REVIEW") {
      const existingReport = await db.moderationReport.findFirst({
        where: { subjectType: "TRACK", subjectId: track.id, status: "PENDING" },
      });
      if (!existingReport) {
        await db.moderationReport.create({
          data: {
            subjectType: "TRACK",
            subjectId: track.id,
            reason: "OTHER",
            details: "Vérification automatique hash/fingerprint à la réception du master",
            status: "PENDING",
          },
        });
      }
    }
  }

  await audit({
    actorId: admin.id,
    action: "system.seed",
    entityType: "System",
    entityId: "seed",
    after: { tracks: TRACKS.length, artists: artistDefs.length },
  });

  console.log(`✔ Seed terminé — admin: +243000000001 / admin-aenews-2024`);
  console.log(`  écouteur démo: +243000000003 / ecoute-aenews-2024`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
