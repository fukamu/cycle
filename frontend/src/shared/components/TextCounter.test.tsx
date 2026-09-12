import { render, screen } from "@testing-library/react";

import { TextCounter } from "./TextCounter";

describe("TextCounter", () => {
  it.each([
    { count: 0, limit: 80 },
    { count: 80, limit: 80 },
    { count: 201, limit: 200 },
  ])("labels $count of $limit code points", ({ count, limit }) => {
    render(
      <TextCounter
        subject="あなたの目標"
        count={count}
        limit={limit}
        invalid={count > limit}
      />,
    );

    const counter = screen.getByRole("status", {
      name: `あなたの目標は上限${limit}文字中${count}文字です`,
    });
    expect(counter).toHaveTextContent(`${count} / ${limit}文字`);
    expect(counter).toHaveAttribute("aria-live", "off");
    expect(counter).toHaveClass("counter");
    if (count > limit) expect(counter).toHaveClass("counter--error");
    else expect(counter).not.toHaveClass("counter--error");
  });
});
