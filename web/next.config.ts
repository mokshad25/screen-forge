import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // contracts/ lives at the repo root, outside /web. Widening the root lets the
  // frozen fixtures be imported directly; copying them into /web would drift.
  turbopack: {
    root: path.join(__dirname, ".."),
  },
};

export default nextConfig;
