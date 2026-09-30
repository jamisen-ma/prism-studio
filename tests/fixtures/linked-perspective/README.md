# Independent linked Perspective fixtures

These fixtures and the dyadic arithmetic oracle were authored for this project, with no copied implementation, external image or third-party dependency. They import no production or owner prototype module.

`LINKED_PERSPECTIVE_RECTANGLE` and eight literal `LINKED_PERSPECTIVE_GOLDENS` cover every selected corner/axis pairing. `linkedPerspectiveReference` evaluates each changed scalar using `addBinary64Reference`: it converts finite Numbers into exact integer multiples of 2^-1074, sums with BigInt and independently rounds to nearest/even binary64. It preserves the zero-delta identity and untouched signed zeros. This is a test-only arithmetic reference, not a proposed runtime BigInt path or a native homography validator.

The reference expects already valid bounded numeric inputs. Strict shape/getter/bounds refusals belong to the maintained audit of the actual helper. Pixel equivalence continues to use existing Distort commands and sampler evidence.
