import type { Metadata } from "next";
import { DashboardShell } from "@/components/dashboard/DashboardShell";
import "./dashboard.css";

export const metadata: Metadata = {
  title: "Panel",
};

export default function DashboardPage() {
  return <DashboardShell />;
}
