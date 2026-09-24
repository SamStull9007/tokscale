"use client";

import { useRef, useEffect, useCallback, useState, useMemo, useId, type KeyboardEvent } from "react";
import styled, { keyframes } from "styled-components";
import type { DailyContribution, GraphColorPalette, TooltipPosition } from "@/lib/types";
import { getGradeColor } from "@/lib/themes";
import { useSystemDarkMode } from "@/lib/useMediaQuery";
import { groupByWeek, hexToNumber, formatCurrency, formatTokenCount, findDayInDirection, contributionCellLabel } from "@/lib/utils";
import { formatContributionDate } from "@/lib/date-utils";
import { CUBE_SIZE, MAX_CUBE_HEIGHT, MIN_CUBE_HEIGHT, ISO_CANVAS_WIDTH, ISO_CANVAS_HEIGHT } from "@/lib/constants";

const pulse = keyframes`
  0%, 100% { opacity: 1; }
  50% { opacity: .5; }
`;

const LoadingContainer = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
`;

const LoadingText = styled.div`
  animation: ${pulse} 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
`;

const ErrorState = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  text-align: center;
`;

const RetryButton = styled.button`
  padding: 6px 16px;
  border: 1px solid;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  background: transparent;
  transition: background-color 150ms ease;

  &:hover {
    background-color: rgba(255, 255, 255, 0.08);
  }

  &:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--service-focus);
  }
`;

const Container = styled.div.attrs({ className: "ic-contributions-wrapper" })`
  position: relative;
  width: 100%;
`;

const StyledCanvas = styled.canvas`
  cursor: pointer;
  width: 100%;
  height: auto;
`;

const Overlay = styled.div`
  position: absolute;
  inset: 0;
  pointer-events: none; /* the canvas beneath already handles mouse hover/click */
`;

const CellButton = styled.button`
  position: absolute;
  padding: 0;
  background: transparent;
  border: 0;
  border-radius: 2px;
  cursor: pointer;
  pointer-events: none; /* the canvas beneath already handles mouse hover/click */

  &:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }
`;

const VisuallyHidden = styled.span`
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
`;

/** Approximates obelisk.js's isometric screen projection for placing an
 * invisible, keyboard-focusable target over each rendered cube — mirrors the
 * inverse math already used in getDayAtPosition below. */
function isoCellPercent(weekIndex: number, dayIndex: number): { left: string; top: string } {
  const x = 130 + weekIndex * CUBE_SIZE * 0.7;
  const y = 90 + CUBE_SIZE * 0.35 * (dayIndex + weekIndex);
  return {
    left: `${(x / ISO_CANVAS_WIDTH) * 100}%`,
    top: `${(y / ISO_CANVAS_HEIGHT) * 100}%`,
  };
}

const TopRightStats = styled.div`
  position: absolute;
  top: 12px;
  right: 20px;
`;

const BottomLeftStats = styled.div`
  position: absolute;
  bottom: 24px;
  left: 20px;
`;

const StatsTitle = styled.h5`
  margin-bottom: 4px;
  font-size: 14px;
  font-weight: 600;
`;

const StatsBox = styled.div`
  display: flex;
  justify-content: space-between;
  border-radius: 6px;
  border-width: 1px;
  border-style: solid;
  padding-left: 4px;
  padding-right: 4px;
  
  @media (min-width: 768px) {
    padding-left: 8px;
    padding-right: 8px;
  }
`;

const StatItem = styled.div`
  padding: 8px;
`;

const HiddenStatItem = styled(StatItem)`
  display: none;
  @media (min-width: 1280px) {
    display: block;
  }
`;

const StatValue = styled.span`
  display: block;
  font-size: 24px;
  font-weight: 700;
  line-height: 1.25;
`;

const StatLabel = styled.span`
  display: block;
  font-size: 12px;
  font-weight: 700;
`;

const StatSubtext = styled.span`
  display: none;
  font-size: 12px;
  
  @media (min-width: 640px) {
    display: block;
  }
`;

const StatsFooter = styled.p`
  margin-top: 4px;
  text-align: right;
  font-size: 12px;
`;

const SpanBase = styled.span`
  font-size: 16px;
`;

const SpanBold = styled.span`
  font-weight: 700;
`;

interface TokenGraph3DProps {
  contributions: DailyContribution[];
  palette: GraphColorPalette;
  year: string;
  maxTokens: number;
  totalCost: number;
  totalTokens: number;
  activeDays: number;
  bestDay: DailyContribution | null;
  currentStreak: number;
  longestStreak: number;
  dateRange: { start: string; end: string };
  onDayHover: (day: DailyContribution | null, position: TooltipPosition | null) => void;
  onDayClick: (day: DailyContribution | null) => void;
}

export function TokenGraph3D({
  contributions,
  palette,
  year,
  maxTokens,
  totalCost,
  totalTokens,
  activeDays,
  bestDay,
  currentStreak,
  longestStreak,
  dateRange,
  onDayHover,
  onDayClick,
}: TokenGraph3DProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [obeliskLoaded, setObeliskLoaded] = useState(false);
  const [obeliskError, setObeliskError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const obeliskRef = useRef<any>(null);
  const cellRefs = useRef(new Map<string, HTMLButtonElement>());
  const summaryId = useId();
  const [focusedDate, setFocusedDate] = useState<string | null>(null);
  const weeksData = useMemo(() => groupByWeek(contributions, year), [contributions, year]);
  const isDark = useSystemDarkMode();

  const days = useMemo(
    () =>
      weeksData.flatMap((week, weekIndex) =>
        week.days.flatMap((day, dayIndex) => (day ? [{ day, weekIndex, dayIndex }] : [])),
      ),
    [weeksData],
  );
  const activeFocusDate =
    focusedDate && days.some(({ day }) => day.date === focusedDate)
      ? focusedDate
      : (bestDay?.date ?? days.at(-1)?.day.date ?? null);
  const summaryText =
    activeDays === 0
      ? "No contribution activity in this range."
      : `${activeDays.toLocaleString("en-US")} active ${activeDays === 1 ? "day" : "days"}. Highest activity: ${
          bestDay ? contributionCellLabel(bestDay) : "none"
        }.`;

  useEffect(() => {
    let cancelled = false;

    async function loadObelisk() {
      setObeliskError(false);
      try {
        const obeliskModule = await import("obelisk.js");
        if (cancelled) return;
        obeliskRef.current = obeliskModule.default || obeliskModule;
        setObeliskLoaded(true);
      } catch (err) {
        console.error("Failed to load obelisk.js:", err);
        if (!cancelled) setObeliskError(true);
      }
    }
    loadObelisk();

    return () => {
      cancelled = true;
    };
  }, [retryCount]);

  useEffect(() => {
    if (!obeliskLoaded || !obeliskRef.current) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const obelisk = obeliskRef.current;

    canvas.width = ISO_CANVAS_WIDTH;
    canvas.height = ISO_CANVAS_HEIGHT;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.fillStyle = isDark ? "#10121C" : "#FFFFFF";
    ctx.fillRect(0, 0, ISO_CANVAS_WIDTH, ISO_CANVAS_HEIGHT);

    const point = new obelisk.Point(130, 90);
    const pixelView = new obelisk.PixelView(canvas, point);

    const GH_OFFSET = 14;
    let transform = GH_OFFSET;

    for (let weekIndex = 0; weekIndex < weeksData.length; weekIndex++) {
      const week = weeksData[weekIndex];
      const x = transform / (GH_OFFSET + 1);
      transform += GH_OFFSET;

      let offsetY = 0;
      for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
        const day = week.days[dayIndex];
        const y = offsetY / GH_OFFSET;
        offsetY += 13;

        let cubeHeight = MIN_CUBE_HEIGHT;
        if (day && maxTokens > 0) {
          cubeHeight = MIN_CUBE_HEIGHT + Math.floor((MAX_CUBE_HEIGHT / maxTokens) * day.totals.tokens);
        }

        const intensity = day?.intensity ?? 0;
        const colorHex = getGradeColor(palette, intensity);
        const resolvedColor = colorHex.startsWith("var(") 
          ? (isDark ? "#1A212A" : "#EBEDF0") 
          : colorHex;
        const colorNum = hexToNumber(resolvedColor);

        const dimension = new obelisk.CubeDimension(CUBE_SIZE, CUBE_SIZE, Math.max(cubeHeight, MIN_CUBE_HEIGHT));
        const color = new obelisk.CubeColor().getByHorizontalColor(colorNum);
        const cube = new obelisk.Cube(dimension, color, false);
        const p3d = new obelisk.Point3D(CUBE_SIZE * x, CUBE_SIZE * y, 0);

        pixelView.renderObject(cube, p3d);
      }
    }
  }, [obeliskLoaded, palette, maxTokens, weeksData, isDark]);

  const getDayAtPosition = useCallback(
    (clientX: number, clientY: number): { day: DailyContribution | null; position: TooltipPosition } | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;

      const rect = canvas.getBoundingClientRect();
      const scaleX = ISO_CANVAS_WIDTH / rect.width;
      const scaleY = ISO_CANVAS_HEIGHT / rect.height;
      const x = (clientX - rect.left) * scaleX;
      const y = (clientY - rect.top) * scaleY;

      const isoX = (x - 130) / (CUBE_SIZE * 0.7);
      const isoY = (y - 90) / (CUBE_SIZE * 0.35) - isoX;

      const weekIndex = Math.floor(isoX);
      const dayIndex = Math.floor(isoY);

      if (weekIndex < 0 || weekIndex >= weeksData.length || dayIndex < 0 || dayIndex >= 7) return null;

      const day = weeksData[weekIndex]?.days[dayIndex] ?? null;
      return { day, position: { x: clientX, y: clientY } };
    },
    [weeksData]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const result = getDayAtPosition(e.clientX, e.clientY);
      if (result) {
        onDayHover(result.day, result.position);
      } else {
        onDayHover(null, null);
      }
    },
    [getDayAtPosition, onDayHover]
  );

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const result = getDayAtPosition(e.clientX, e.clientY);
      if (result?.day) onDayClick(result.day);
    },
    [getDayAtPosition, onDayClick]
  );

  const handleCellFocus = useCallback(
    (day: DailyContribution, event: React.FocusEvent<HTMLButtonElement>) => {
      setFocusedDate(day.date);
      const rect = event.currentTarget.getBoundingClientRect();
      onDayHover(day, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    },
    [onDayHover]
  );

  const handleCellKeyDown = useCallback(
    (day: DailyContribution, weekIndex: number, dayIndex: number, event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onDayClick(day);
        return;
      }

      let target: { day: DailyContribution; weekIndex: number; dayIndex: number } | null = null;
      switch (event.key) {
        case "ArrowLeft":
          target = findDayInDirection(weeksData, weekIndex, dayIndex, -1, 0);
          break;
        case "ArrowRight":
          target = findDayInDirection(weeksData, weekIndex, dayIndex, 1, 0);
          break;
        case "ArrowUp":
          target = findDayInDirection(weeksData, weekIndex, dayIndex, 0, -1);
          break;
        case "ArrowDown":
          target = findDayInDirection(weeksData, weekIndex, dayIndex, 0, 1);
          break;
        case "Home":
          target = days[0] ?? null;
          break;
        case "End":
          target = days.at(-1) ?? null;
          break;
        default:
          return;
      }

      event.preventDefault();
      if (!target) return;
      setFocusedDate(target.day.date);
      cellRefs.current.get(target.day.date)?.focus();
    },
    [weeksData, days]
  );

  if (!obeliskLoaded) {
    return (
      <LoadingContainer
        ref={containerRef}
        style={{ aspectRatio: `${ISO_CANVAS_WIDTH} / ${ISO_CANVAS_HEIGHT}`, backgroundColor: isDark ? "#10121C" : "#FFFFFF" }}
      >
        {obeliskError ? (
          <ErrorState role="alert">
            <LoadingText style={{ color: isDark ? "#4B6486" : "#656D76", animation: "none" }}>
              Couldn&rsquo;t load the 3D view.
            </LoadingText>
            <RetryButton
              type="button"
              style={{ color: isDark ? "#FFFFFF" : "#1F2328", borderColor: isDark ? "#1E2733" : "#D0D7DE" }}
              onClick={() => setRetryCount((count) => count + 1)}
            >
              Retry
            </RetryButton>
          </ErrorState>
        ) : (
          <LoadingText style={{ color: isDark ? "#4B6486" : "#656D76" }}>Loading 3D view...</LoadingText>
        )}
      </LoadingContainer>
    );
  }

  return (
    <Container ref={containerRef}>
      <StyledCanvas
        ref={canvasRef}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => onDayHover(null, null)}
        onClick={handleClick}
        style={{ aspectRatio: `${ISO_CANVAS_WIDTH} / ${ISO_CANVAS_HEIGHT}` }}
      />
      <Overlay>
        {days.map(({ day, weekIndex, dayIndex }) => (
          <CellButton
            key={day.date}
            ref={(node) => {
              if (node) cellRefs.current.set(day.date, node);
              else cellRefs.current.delete(day.date);
            }}
            type="button"
            tabIndex={day.date === activeFocusDate ? 0 : -1}
            aria-label={contributionCellLabel(day)}
            style={{ ...isoCellPercent(weekIndex, dayIndex), width: 10, height: 10 }}
            onFocus={(event) => handleCellFocus(day, event)}
            onBlur={() => onDayHover(null, null)}
            onKeyDown={(event) => handleCellKeyDown(day, weekIndex, dayIndex, event)}
          />
        ))}
      </Overlay>
      <VisuallyHidden id={summaryId} aria-live="polite">
        {summaryText}
      </VisuallyHidden>

      <TopRightStats>
        <StatsTitle style={{ color: isDark ? "#FFFFFF" : "#1F2328" }}>Token Usage</StatsTitle>
        <StatsBox
          style={{ borderColor: isDark ? "#1E2733" : "#D0D7DE", backgroundColor: isDark ? "#1A212A" : "#FFFFFF" }}
        >
          <StatItem>
            <StatValue style={{ color: palette.grade1 }}>{formatCurrency(totalCost)}</StatValue>
            <StatLabel style={{ color: isDark ? "#FFFFFF" : "#1F2328" }}>Total</StatLabel>
            <StatSubtext style={{ color: isDark ? "#4B6486" : "#656D76" }}>{dateRange.start} → {dateRange.end}</StatSubtext>
          </StatItem>
          <HiddenStatItem>
            <StatValue style={{ color: palette.grade1 }}>{formatTokenCount(totalTokens)}</StatValue>
            <StatLabel style={{ color: isDark ? "#FFFFFF" : "#1F2328" }}>Tokens</StatLabel>
            <StatSubtext style={{ color: isDark ? "#4B6486" : "#656D76" }}>{activeDays} active days</StatSubtext>
          </HiddenStatItem>
          {bestDay && (
            <StatItem>
              <StatValue style={{ color: palette.grade1 }}>{formatCurrency(bestDay.totals.cost)}</StatValue>
              <StatLabel style={{ color: isDark ? "#FFFFFF" : "#1F2328" }}>Best day</StatLabel>
              <StatSubtext style={{ color: isDark ? "#4B6486" : "#656D76" }}>{formatContributionDate(bestDay).split(",")[0]}</StatSubtext>
            </StatItem>
          )}
        </StatsBox>
        <StatsFooter style={{ color: isDark ? "#4B6486" : "#656D76" }}>
          Average: <SpanBold style={{ color: palette.grade1 }}>{formatCurrency(activeDays > 0 ? totalCost / activeDays : 0)}</SpanBold> / day
        </StatsFooter>
      </TopRightStats>

      <BottomLeftStats>
        <StatsTitle style={{ color: isDark ? "#FFFFFF" : "#1F2328" }}>Streaks</StatsTitle>
        <StatsBox
          style={{ borderColor: isDark ? "#1E2733" : "#D0D7DE", backgroundColor: isDark ? "#1A212A" : "#FFFFFF" }}
        >
          <StatItem>
            <StatValue style={{ color: palette.grade1 }}>{longestStreak} <SpanBase>days</SpanBase></StatValue>
            <StatLabel style={{ color: isDark ? "#FFFFFF" : "#1F2328" }}>Longest</StatLabel>
          </StatItem>
          <StatItem>
            <StatValue style={{ color: palette.grade1 }}>{currentStreak} <SpanBase>days</SpanBase></StatValue>
            <StatLabel style={{ color: isDark ? "#FFFFFF" : "#1F2328" }}>Current</StatLabel>
          </StatItem>
        </StatsBox>
      </BottomLeftStats>
    </Container>
  );
}
