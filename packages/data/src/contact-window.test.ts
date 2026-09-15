import { describe, expect, it } from 'vitest';
import { contactWindowFromPolicy } from './contact-window.js';

describe('administrator contact hours', () => {
  it('accepts 09:00–21:00 and preserves unrelated policy fields', () => {
    expect(contactWindowFromPolicy({startMinute:540,endMinute:1260,dailyLimit:20})).toEqual({startMinute:540,endMinute:1260});
    expect(contactWindowFromPolicy({startMinute:0,endMinute:1440})).toEqual({startMinute:0,endMinute:1440});
  });
  it('does not change hours for older control requests without a window', () => {
    expect(contactWindowFromPolicy({dailyLimit:20})).toBeNull();
    expect(contactWindowFromPolicy(null)).toBeNull();
  });
  it.each([{startMinute:540}, {startMinute:1260,endMinute:540}, {startMinute:540,endMinute:540}, {startMinute:-1,endMinute:1260}, {startMinute:540,endMinute:1441}, {startMinute:540.5,endMinute:1260}, {startMinute:'540',endMinute:1260}])('rejects invalid hours before updating controls: %s', policy => {
    expect(()=>contactWindowFromPolicy(policy)).toThrow('联系时段');
  });
});
