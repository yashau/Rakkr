import type { AudioLevel } from "@rakkr/shared";
import { Activity, RadioTower } from "lucide-react";

import { cn } from "@/lib/utils";

function levelToPercent(dbfs: number) {
  const floor = -72;
  const ceiling = -3;
  return Math.max(0, Math.min(100, ((dbfs - floor) / (ceiling - floor)) * 100));
}

function levelTone(peakDbfs: number) {
  if (peakDbfs > -6) {
    return "from-emerald-500 via-amber-400 to-red-500";
  }

  if (peakDbfs > -18) {
    return "from-emerald-500 via-lime-400 to-amber-400";
  }

  return "from-teal-500 via-emerald-400 to-lime-300";
}

export function MeterBank({ levels, title }: { levels: AudioLevel[]; title: string }) {
  return (
    <section className="rounded-lg border border-border bg-panel p-4 shadow-sm">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-md bg-emerald-100 text-emerald-700">
            <Activity className="size-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-panel-foreground">{title}</h2>
            <p className="text-xs text-muted-foreground">RMS and peak dBFS</p>
          </div>
        </div>
        <RadioTower className="size-5 text-teal-600" />
      </div>

      <div className="grid gap-3">
        {levels.map((level) => {
          const rms = levelToPercent(level.rmsDbfs);
          const peak = levelToPercent(level.peakDbfs);

          return (
            <div
              className="grid grid-cols-[minmax(72px,120px)_1fr_minmax(86px,96px)] items-center gap-3"
              key={level.channelIndex}
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-foreground">{level.label}</div>
                <div className="text-xs text-muted-foreground">Ch {level.channelIndex}</div>
              </div>

              <div className="relative h-7 overflow-hidden rounded-md border border-stone-300 bg-stone-100">
                <div
                  className={cn(
                    "absolute inset-y-0 left-0 rounded-sm bg-linear-to-r transition-[width] duration-300",
                    levelTone(level.peakDbfs),
                  )}
                  style={{ width: `${rms}%` }}
                />
                <div
                  className="absolute inset-y-1 w-0.5 rounded-full bg-zinc-950/70"
                  style={{ left: `${peak}%` }}
                />
                <div className="absolute inset-0 bg-[linear-gradient(90deg,transparent_0,transparent_calc(20%-1px),rgba(0,0,0,.14)_20%,transparent_calc(20%+1px),transparent_calc(40%-1px),rgba(0,0,0,.14)_40%,transparent_calc(40%+1px),transparent_calc(60%-1px),rgba(0,0,0,.14)_60%,transparent_calc(60%+1px),transparent_calc(80%-1px),rgba(0,0,0,.14)_80%,transparent_calc(80%+1px))]" />
              </div>

              <div className="text-right font-mono text-xs text-foreground">
                {level.rmsDbfs.toFixed(1)} dB
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
