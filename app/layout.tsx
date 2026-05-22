import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Le Châtelier Lab · 2 NO₂ ⇌ N₂O₄",
  description:
    "Interactive molecular-scale simulation of chemical equilibrium. Disturb the system with temperature, pressure, concentration, and a catalyst, and watch Le Châtelier's principle play out.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
