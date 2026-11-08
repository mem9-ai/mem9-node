import { trimTrailingCharacters } from './trim-trailing-characters';

describe('trailing punctuation without backtracking', () => {
  it.each([
    ['', ''],
    ['；，、。,.:：;', ''],
    ['🙂；，。', '🙂'],
    ['first; second. sentence；', 'first; second. sentence'],
    ['end!！?？', 'end!！?？'],
    ['end;\n', 'end;\n'],
    ['end. ', 'end. '],
  ])('preserves summary punctuation semantics for %j', (input, expected) => {
    expect(trimTrailingCharacters(input, '；，、。,.:：;')).toBe(expected);
  });

  it.each(['', 'text', '用户：你好。', '🙂?!', 'a\n.', 'a.\n', '。.!?？！'])(
    'preserves inline clause semantics for %j',
    (input) => {
      expect(trimTrailingCharacters(input, '。.!?？！')).toBe(
        input.replace(/[。.!?？！]+$/u, ''),
      );
    },
  );
});
