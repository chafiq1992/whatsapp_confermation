jest.mock('wavesurfer.js', () => ({}));

const { getSafeMediaUrl } = require('./MessageBubble');

describe('getSafeMediaUrl', () => {
  it('rewrites /app/ paths to /media/', () => {
    expect(getSafeMediaUrl('/app/media/foo.ogg')).toBe('/media/foo.ogg');
  });
});
