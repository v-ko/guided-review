    const panel = await page.client.evaluate(
      `(() => {
      const panel = document.getElementById('comment-panel');
      const content = document.getElementById('comment-content');
      const sidebar = document.getElementById('sidebar');
      const suggestions = document.getElementById('suggestions');
      const doc = document.getElementById('document');
      const width = doc.getBoundingClientRect().width;
      document.getElementById('column-divider').dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowLeft', bubbles:true}));
      const resizedWidth = doc.getBoundingClientRect().width;
      const height = panel.getBoundingClientRect().height;
      document.getElementById('comment-divider').dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown', bubbles:true}));
      const resizedHeight = panel.getBoundingClientRect().height;
      const result = {
        scrolls: content.scrollHeight > content.clientHeight,
        bounded: panel.getBoundingClientRect().height <= sidebar.clientHeight * 0.65 + 1,
        belowSuggestions: panel.getBoundingClientRect().top >= suggestions.getBoundingClientRect().bottom - 1,
        widthChanged: resizedWidth < width,
        heightChanged: resizedHeight < height,
      };
      // The smallest expanded panel must still show a useful, scrollable reply.
      for (let n = 0; n < 40; n++)
        document.getElementById('comment-divider').dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown', bubbles:true}));
      result.minimumHeight = Math.abs(panel.getBoundingClientRect().height - 160) < 1;
      result.readableReply = content.clientHeight >= 80 && content.scrollHeight > content.clientHeight;
      document.getElementById('comment-toggle').click();
      result.collapsed = panel.classList.contains('collapsed') && panel.getBoundingClientRect().height < 80;
      return result;
    })()`,
      page.contextId,
    );
    assert.deepEqual(panel, {
      scrolls: true,
      bounded: true,
      belowSuggestions: true,
      widthChanged: true,
      heightChanged: true,
      minimumHeight: true,
      readableReply: true,
      collapsed: true,
    });
