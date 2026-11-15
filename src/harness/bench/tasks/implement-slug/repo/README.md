# slug

`slugify(text)` turns a title into a URL slug:

- lowercase;
- accented letters lose their accents (`é` becomes `e`, `ñ` becomes `n`);
- every run of characters that are not ASCII letters or digits becomes one hyphen;
- no hyphen at the start or the end;
- an empty result is `"n-a"`.

`slugify("  Héllo, World!  ")` is `"hello-world"`.
