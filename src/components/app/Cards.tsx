import Link from "next/link";

export function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-sm border border-ink-700 bg-ink-900 p-5">
      <p className="text-xs text-paper/50">{label}</p>
      <p className="mt-2 font-display text-3xl text-paper">{value}</p>
    </div>
  );
}

const statusStyles: Record<string, string> = {
  DRAFT: "text-paper/50 border-ink-600",
  QUEUED: "text-lantern-400 border-lantern-500/40",
  PROCESSING: "text-lantern-400 border-lantern-500/40",
  COMPLETED: "text-moon-400 border-moon-500/40",
  FAILED: "text-red-300 border-red-500/40",
};

export interface ProjectSummary {
  id: string;
  title: string;
  language: string;
  animeStyle: string;
  duration: string;
  status: string;
  createdAt: string;
}

export function ProjectCard({ project }: { project: ProjectSummary }) {
  return (
    <Link
      href={`/projects/${project.id}`}
      className="block rounded-sm border border-ink-700 bg-ink-900 p-5 transition hover:border-moon-400"
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-display text-lg text-paper">{project.title}</h3>
        <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs ${statusStyles[project.status] ?? ""}`}>
          {project.status}
        </span>
      </div>
      <p className="mt-2 text-sm text-paper/60">
        {project.language} · {project.animeStyle} · {project.duration}
      </p>
      <p className="mt-1 text-xs text-paper/40">{new Date(project.createdAt).toLocaleDateString()}</p>
    </Link>
  );
}
