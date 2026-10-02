import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Audit v1.1 F6 : la barrière qualité est RÉACTIVÉE — le build échoue sur
  // toute erreur TypeScript (le code passe tsc strict propre ; cette garde
  // empêche une régression de type de partir en production).
  typescript: {
    ignoreBuildErrors: false,
  },
  reactStrictMode: true,
};

export default nextConfig;
