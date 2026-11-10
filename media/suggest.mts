function setCommentHeight(value: number): void {
  const limit = sidebar.clientHeight * 0.65;
  const minimum = Math.min(160, limit);
  viewState.commentHeight = Math.max(minimum, Math.min(limit, value));
  commentPanel.style.setProperty(
    "--comment-height",
    `${viewState.commentHeight}px`,
  );
  const divider = requiredElement("comment-divider");
  divider.setAttribute(
    "aria-valuenow",
    String(Math.round(viewState.commentHeight)),
  );
  divider.setAttribute("aria-valuemin", String(Math.round(minimum)));
  divider.setAttribute("aria-valuemax", String(Math.round(limit)));
}
