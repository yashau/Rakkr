import type { AudioLevel } from "@rakkr/shared";
import { Activity, AudioWaveform, RadioTower, ShieldAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { meterBankSummary, meterChannelView, meterScaleLabels } from "@/lib/meter-helpers";
import { cn } from "@/lib/utils";

export function MeterBank({ levels, title }: { levels: AudioLevel[]; title: string }) {
  const summary = meterBankSummary(levels);

  return (
    <section className="rounded-lg border border-border bg-panel p-4 shadow-sm">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-md bg-sky-100 text-sky-700">
            <Activity className="size-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-panel-foreground">{title}</h2>
            <p className="text-xs text-muted-foreground">
              {levels.length} channels / peak {summary.maxPeakDbfs}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {summary.clippingChannels > 0 ? (
            <Badge className="border-red-200 bg-red-50 text-red-700" variant="outline">
              <ShieldAlert className="size-3" />
              {summary.clippingChannels} clip
            </Badge>
          ) : null}
          <RadioTower className="size-5 text-teal-600" />
        </div>
      </div>

      <div className="mb-4 grid grid-cols-3 gap-2 text-xs">
        <MeterStat label="Max RMS" value={summary.maxRmsDbfs} />
        <MeterStat label="Voice-like" value={`${summary.speechChannels}/${levels.length}`} />
        <MeterStat label="Clipping" value={String(summary.clippingChannels)} />
      </div>

      <div className="mb-2 grid grid-cols-[minmax(72px,120px)_1fr_minmax(86px,112px)] gap-3 px-1 text-[11px] text-muted-foreground">
        <span>Channel</span>
        <div className="grid grid-cols-6">
          {meterScaleLabels.map((label) => (
            <span className="text-right tabular-nums" key={label}>
              {label}
            </span>
          ))}
        </div>
        <span className="text-right">Level</span>
      </div>

      <div className="grid gap-3">
        {levels.map((level) => {
          const channel = meterChannelView(level);

          return (
            <div
              className="grid grid-cols-[minmax(72px,120px)_1fr_minmax(86px,112px)] items-center gap-3"
              key={level.channelIndex}
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-foreground">{level.label}</div>
                <div className="flex flex-wrap gap-1 text-xs text-muted-foreground">
                  <span>Ch {level.channelIndex}</span>
                  <span>/</span>
                  <span>{channel.speechLabel}</span>
                </div>
              </div>

              <div className="relative h-8 overflow-hidden rounded-md border border-stone-300 bg-stone-100">
                <div
                  className={cn(
                    "absolute inset-y-0 left-0 rounded-sm bg-linear-to-r shadow-[0_0_16px_rgba(14,165,233,.18)] transition-[width] duration-300",
                    channel.toneClass,
                  )}
                  style={{ width: `${channel.rmsPercent}%` }}
                />
                <div
                  className="absolute inset-y-1 w-0.5 rounded-full bg-zinc-950/70 shadow-[0_0_10px_rgba(24,24,27,.35)]"
                  style={{ left: `${channel.peakPercent}%` }}
                />
                <div className="absolute inset-0 bg-[linear-gradient(90deg,transparent_0,transparent_calc(20%-1px),rgba(0,0,0,.14)_20%,transparent_calc(20%+1px),transparent_calc(40%-1px),rgba(0,0,0,.14)_40%,transparent_calc(40%+1px),transparent_calc(60%-1px),rgba(0,0,0,.14)_60%,transparent_calc(60%+1px),transparent_calc(80%-1px),rgba(0,0,0,.14)_80%,transparent_calc(80%+1px))]" />
                {channel.clipping ? (
                  <div className="absolute inset-y-0 right-0 flex w-7 items-center justify-center bg-red-500 text-white">
                    <ShieldAlert className="size-4" />
                  </div>
                ) : null}
              </div>

              <div className="grid gap-1 text-right font-mono text-xs text-foreground">
                <span>{channel.rmsDbfs}</span>
                <span className="text-muted-foreground">{channel.peakDbfs} peak</span>
              </div>

              {channel.speechPercent !== undefined || channel.noisePercent !== undefined ? (
                <>
                  <span aria-hidden />
                  <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <AudioWaveform className="size-4 text-sky-600" />
                    {channel.speechPercent !== undefined ? (
                      <span>speech {channel.speechPercent}%</span>
                    ) : null}
                    {channel.noisePercent !== undefined ? (
                      <span>noise {channel.noisePercent}%</span>
                    ) : null}
                    {channel.snrDb !== undefined ? <span>SNR {channel.snrDb}</span> : null}
                    {channel.intelligibilityPercent !== undefined ? (
                      <span>intel {channel.intelligibilityPercent}%</span>
                    ) : null}
                    {channel.humPercent !== undefined ? (
                      <span>hum {channel.humPercent}%</span>
                    ) : null}
                    {channel.staticPercent !== undefined ? (
                      <span>static {channel.staticPercent}%</span>
                    ) : null}
                    {channel.correlationPercent !== undefined ? (
                      <span>
                        corr {channel.correlationLabel} {channel.correlationPercent}%
                      </span>
                    ) : null}
                  </div>
                  <span aria-hidden />
                </>
              ) : null}
            </div>
          );
        })}

        {levels.length === 0 ? (
          <div className="rounded-md border border-dashed border-border bg-muted/20 p-4 text-sm text-muted-foreground">
            Waiting for meter frames.
          </div>
        ) : null}
      </div>
    </section>
  );
}

function MeterStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-background px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-1 truncate font-mono text-xs font-semibold text-foreground">{value}</div>
    </div>
  );
}
