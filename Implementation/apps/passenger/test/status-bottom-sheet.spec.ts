import {
  statusBottomSheetPositionAfterDrag,
  toggleStatusBottomSheet,
} from '../src/status-bottom-sheet';

describe('pannello dello stato corsa', () => {
  it('alterna la posizione con un tocco', () => {
    expect(toggleStatusBottomSheet('collapsed')).toBe('expanded');
    expect(toggleStatusBottomSheet('expanded')).toBe('collapsed');
  });

  it('si espande trascinandolo verso l’alto', () => {
    expect(statusBottomSheetPositionAfterDrag('collapsed', -40)).toBe('expanded');
  });

  it('si ritrae trascinandolo verso il basso', () => {
    expect(statusBottomSheetPositionAfterDrag('expanded', 40)).toBe('collapsed');
  });

  it('ignora i trascinamenti inferiori alla soglia', () => {
    expect(statusBottomSheetPositionAfterDrag('collapsed', -39)).toBe('collapsed');
    expect(statusBottomSheetPositionAfterDrag('expanded', 39)).toBe('expanded');
  });
});
