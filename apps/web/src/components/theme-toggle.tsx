import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import * as React from "react";

import { Switch } from "@/components/ui/switch";
import { isDarkResolved, themeForToggle } from "@/lib/theme-helpers";
import { cn } from "@/lib/utils";

/**
 * Sun/Moon switch for dark mode. Defaults to following the system theme
 * (next-themes `defaultTheme="system"`); flipping it writes an explicit
 * light/dark override that persists across reloads.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  // next-themes only resolves the theme on the client after mount. Guard the
  // first render so the switch never renders in the wrong position and flips
  // under the operator once hydration settles.
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  const isDark = mounted && isDarkResolved(resolvedTheme);

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Sun
        aria-hidden
        className={cn(
          "size-4 transition-colors",
          isDark ? "text-muted-foreground" : "text-foreground",
        )}
      />
      <Switch
        aria-label="Dark mode"
        checked={isDark}
        disabled={!mounted}
        onCheckedChange={(checked) => setTheme(themeForToggle(checked))}
      />
      <Moon
        aria-hidden
        className={cn(
          "size-4 transition-colors",
          isDark ? "text-foreground" : "text-muted-foreground",
        )}
      />
    </div>
  );
}
