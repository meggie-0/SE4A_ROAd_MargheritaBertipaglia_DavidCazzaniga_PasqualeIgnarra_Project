export type StatusBottomSheetPosition = 'collapsed' | 'expanded';

export const STATUS_BOTTOM_SHEET_DRAG_THRESHOLD_PX = 40;

export function toggleStatusBottomSheet(
  current: StatusBottomSheetPosition,
): StatusBottomSheetPosition {
  return current === 'collapsed' ? 'expanded' : 'collapsed';
}

export function statusBottomSheetPositionAfterDrag(
  current: StatusBottomSheetPosition,
  verticalMovement: number,
): StatusBottomSheetPosition {
  if (verticalMovement <= -STATUS_BOTTOM_SHEET_DRAG_THRESHOLD_PX) {
    return 'expanded';
  }

  if (verticalMovement >= STATUS_BOTTOM_SHEET_DRAG_THRESHOLD_PX) {
    return 'collapsed';
  }

  return current;
}
