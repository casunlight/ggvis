/*jshint forin:true, noarg:true, noempty:true, eqeqeq:true, bitwise:true,
    strict:false, undef:true, unused:true, browser:true, jquery:true, maxerr:50,
    curly:false, multistr:true */
/*global vg, ggvis:true, lodash*/

ggvis = (function(_) {
  var ggvis = {
    // Keep track of information about all plots: contains ggvis.Plot objects
    plots: {}
  };

  // Get a ggvis.Plot object with a particular name, creating it if needed
  ggvis.getPlot = function(plotId) {
    if (!this.plots[plotId]) {
      this.plots[plotId] = new ggvis.Plot(plotId);
    }
    return this.plots[plotId];
  };

  // Are we in a viewer pane?
  ggvis.inViewerPane = function() {
    return queryVar("viewer_pane") === "1";
  };

  // Private methods --------------------------------------------------

  // Returns the value of a GET variable
  function queryVar (name) {
    return decodeURI(window.location.search.replace(
      new RegExp("^(?:.*[&\\?]" +
                 encodeURI(name).replace(/[\.\+\*]/g, "\\$&") +
                 "(?:\\=([^&]*))?)?.*$", "i"),
      "$1"));
  }


  // ggvis.Plot class ----------------------------------------------------------
  ggvis.Plot = (function() {

    var Plot = function(plotId) {
      this.plotId = plotId;
      this.pendingData = {}; // Data objects that have been received but not yet used
      this.chart = null;     // Vega chart object on the page
      this.spec = null;      // Vega spec for this plot
      this.initialized = false; // Has update() or enter() been run?
      this.opts = {};
      this.brush = new Plot.Brush(this);
    };

    var prototype = Plot.prototype;

    // opts is an optional object which can have any entries that are in spec.opts
    // (they get merged on top of spec.opts), and additionally:
    // * hovertime: Number of milliseconds for a hover transition
    // * handlers: An object where the keys are event names and the values are
    //     functions. They are passed to Vega's view.on(key, value), which
    //     registers the handler functions for the named event.
    prototype.parseSpec = function(spec, opts) {
      var self = this;
      self.spec = spec;
      self.initialized = false;
      // Merge options passed to this function into options from the spec
      self.opts = $.extend(true, self.spec.ggvis_opts, opts);

      vg.parse.spec(spec, function(chart) {
        var opts = self.opts;

        // If hovertime is supplied, use that later in a custom callback,
        // instead of the default hover behavior.
        var hover = true;
        if (opts.hovertime && opts.hovertime !== 0) hover = false;

        chart = chart({
          el: "#" + self.plotId,
          renderer: opts.renderer || "canvas",
          hover: hover
        });
        // Save the chart object
        self.chart = chart;

        // Set the renderer (update buttons and download link)
        self.setRenderer(opts.renderer, false);

        // If hovertime is specified, set callbacks for hover behavior
        if (opts.hovertime && opts.hovertime !== 0) {
          chart.on("mouseover", function(event, item) {
            this.update({ props:"hover", items:item, duration:opts.hovertime });
          });
          chart.on("mouseout", function(event, item) {
            this.update({ props:"update", items:item, duration:opts.hovertime });
          });
        }

        // If handlers are specified (typically for mouseover and out), add them.
        if (opts.handlers) {
          $.each(opts.handlers, function(eventname, fn) {
            chart.on(eventname, fn);
          });
        }

        // If there's a brush mark, turn on brushing
        if (self.brush.hasBrush()) self.brush.enable();

        if (ggvis.inViewerPane()) {
          self.enableAutoResizeToWindow();
        } else if (opts.resizable) {
          self.enableResizable();
        }

        // If the data arrived earlier, use it.
        if (this.pendingData) self.loadPendingData();

        if (self.dataReady()) self.initialUpdate();
      });
    };

    // Get the div which wraps the svg or canvas object (created by vega).
    prototype.getVegaDiv = function() {
      // This is also known is this.getDiv().children(".vega")
      return $(this.chart._el);
    };

    // Get the div which wraps the .vega div
    prototype.getDiv = function() {
      return $("#" + this.plotId);
    };

    // Wrapper div, which includes sizing handle and gear
    prototype.getWrapper = function() {
      return this.getDiv().parent();
    };

    // Get the marks object (the Canvas or SVG object, which is rendered too)
    prototype.getMarks = function() {
      // Can't do this.getVegaDiv().children(".marks") because it doesn't work
      // for SVG DOM objects. So we'll just grab any svg or canvas object.
      return this.getVegaDiv().children("svg, canvas");
    };

    // Set the width of the chart to the wrapper div. If keep_aspect is true,
    // also set the height to maintain the aspect ratio.
    prototype.resizeToWrapper = function(duration, keep_aspect) {
      if (duration === undefined) duration = this.opts.duration;
      if (duration === undefined) duration = 0;
      if (keep_aspect === undefined) keep_aspect = this.opts.keep_aspect;
      if (keep_aspect === undefined) keep_aspect = false;

      var $div = this.getDiv(),
          $wrap = this.getWrapper(),
          $gear = $div.siblings().filter(".plot-gear-icon"),
          chart = this.chart,
          padding = chart.padding(),
          ratio = this.opts.width/this.opts.height;

      var newWidth = $wrap.width() - $gear.width() - padding.left - padding.right,
          newHeight = $wrap.height() - padding.top - padding.bottom;

      if (keep_aspect) {
        if (newHeight > newWidth / ratio) {
          newHeight = Math.floor(newWidth / ratio);
        } else if (newHeight < newWidth / ratio) {
          newWidth = Math.floor(newHeight * ratio);
        }
      }
      // Chart height ends up 5 pixels too large, so compensate for it
      newHeight -= 5;

      chart.width(newWidth);
      chart.height(newHeight);
      chart.update({ duration: duration });
    };

    // Set width and height to fill window
    prototype.resizeToWindow = function(duration) {
      var $body = $('body');
      var $wrap = this.getWrapper();

      // Left and right padding of body element
      var padding_left  = parseFloat($body.css("padding-left").replace("px", ""));
      var padding_right = parseFloat($body.css("padding-right").replace("px", ""));

      // Resize the wrapper div to the window, inside of scrollbars if present
      // The wrapper has overflow:hidden so that objects inside of it won't
      // scrollbars to appear while it's being resized.
      var docEl = document.documentElement;
      $wrap.width(docEl.clientWidth - padding_left - padding_right);
      $wrap.height(docEl.clientHeight);
      // Resize again - needed because if the first resize caused a scrollbar to
      // disappear, there will be a little extra space.
      $wrap.width(docEl.clientWidth - padding_left - padding_right);
      $wrap.height(docEl.clientHeight);

      // Now if there are any other elements in the body that cause the page to
      // be larger than the window (like controls), we need to shrink the
      // plot so that they end up inside the window.
      $wrap.height(2 * docEl.clientHeight - $body.height());

      this.resizeToWrapper(duration);
    };

    // Change the dimensions of the wrapper div to fit the plot.
    // This is useful when the we're not auto-sizing the plot, and the plot is
    // smaller than the window; if we don't do this, then the div will take the
    // full window width, but the plot will be smaller.
    prototype.resizeWrapperToPlot = function() {
      var $wrap   = this.getWrapper();  // wrapper around $div
      var $div    = this.getDiv();      // ggvis div, containing $el
      var $vega   = this.getVegaDiv();  // Immediate wrapper around marks
      var $marks  = this.getMarks();
      var $gear   = $div.siblings().filter(".plot-gear-icon");

      // Need to use getAttribute because itt works for both svg and canvas
      // DOM objects. (marks.width doesn't work for SVG, nor does)
      var width = Math.ceil($marks.width());
      // There are 5 extra pixels in the bottom
      var height = Math.ceil($marks.height() + 5);

      $vega.width(width).height(height);
      $div.width(width).height(height);
      $wrap.width(width + $gear.width()).height(height);
    };

    // Run an update on the chart for the first time
    prototype.initialUpdate = function() {
      // If chart hasn't been run yet, we need to run it once so that
      // resizeToWrapper will work properly (it needs the spec to have been run
      // before it can figure out what the padding will be).
      if (!this.initialized) this.chart.update({ duration: 0 });

      this.initialized = true;

      // Resizing to fit has to happen after the initial update
      if (ggvis.inViewerPane()) {
        this.resizeToWindow(0);
      } else {
        this.resizeWrapperToPlot();
      }
    };

    // Make manually resizable (by dragging corner)
    prototype.enableResizable = function() {
      var $el = this.getDiv().parent();
      var self = this;

      // When done resizing, update chart with new width and height
      $el.resizable({
        helper: "ui-resizable-helper",
        grid: [10, 10],
        handles: "se",
        stop: function() { self.resizeToWrapper(); }
      });
    };

    // Make the plot auto-resize to fit window, if in viewer panel
    prototype.enableAutoResizeToWindow = function() {
      var self = this;
      var debounce_id = null;

      $(window).resize(function() {
        clearTimeout(debounce_id);
        // Debounce to 100ms
        debounce_id = setTimeout(function() { self.resizeToWindow(); }, 100);
      });
    };

    // This is called when control outputs for a plot are updated
    prototype.onControlOutput = function() {
      if (ggvis.inViewerPane()) {
        this.resizeToWindow(0);
      }
    };

    prototype.loadPendingData = function() {
      this.chart.data(this.pendingData);
      delete this.pendingData;
    };

    // Returns true if all data objects for a spec have been registered, using
    // this.chart.data(dataset)
    prototype.dataReady = function() {
      var existing_data = Object.keys(this.chart.data());
      var expected_data = this.spec.data.map(function (x) {
        return x.name ;
      });

      return arraysEqual(existing_data, expected_data);
    };

    // Set the renderer, and update the renderer button and download link text if
    // present. Also update the chart (unless update is false).
    // renderer is either "canvas" or "svg".
    prototype.setRenderer = function(renderer, update) {
      if (update === undefined) update = true;

      this.renderer = renderer;
      if (update) {
        this.chart.renderer(renderer).update();
      }
      this.setRendererButton(renderer);
      this.updateDownloadButtonText(renderer);
    };

    // Set the value of the renderer button, if present
    prototype.setRendererButton = function(renderer) {
      var $el = $("#" + this.plotId + "_renderer_" + renderer);

      // Toggle the renderer buttons when clicked
      $el.addClass('active');
      $el.siblings().removeClass('active');
    };

    // Given an <a> element, set the href of that element to the canvas content
    // of the plot converted to SVG or PNG. This will set the href when the link
    // is clicked; the download happens when it is released.
    prototype.updateDownloadLink = function(el) {
      var plot = $("#" + this.plotId + ".ggvis-output .marks")[0];
      var imageUrl;

      if (this.renderer === "svg") {
        // Extract the svg code and add needed xmlns attribute
        var svg = $(plot).clone().attr("xmlns", "http://www.w3.org/2000/svg");
        // Convert to string
        svg = $('<div>').append(svg).html();
        imageUrl = "data:image/octet-stream;base64,\n" + btoa(svg);

      } else if (this.renderer === "canvas") {
        imageUrl = plot.toDataURL("image/png").replace("image/png", "image/octet-stream");
      }

      // Set download filename and data URL
      var ext = "";
      if      (this.renderer === "svg")    ext = ".svg";
      else if (this.renderer === "canvas") ext = ".png";
      el.setAttribute("download", this.plotId + ext);
      el.setAttribute("href", imageUrl);
    };

    prototype.updateDownloadButtonText = function(renderer) {
      var $el = $("#" + this.plotId + "_download");
      if ($el[0]) {
        var filetype = "";
        if      (renderer === "svg")    filetype = "SVG";
        else if (renderer === "canvas") filetype = "PNG";

        $el.text("Download " + filetype);
      }
    };


    // Private methods ------------------------------------------------

    // Returns all top-level mark definitions in the scene graph.
    // These are available as soon as the spec is parsed.
    prototype._allMarkDefs = function() {
      return this.chart.model().defs().marks.marks;
    };

    // Returns all top-level marks in the scene graph.
    // These are available after the first update.
    prototype._allMarks = function() {
      return this.chart.model().scene().items[0].items;
    };

    prototype._getSceneBounds = function() {
      return this.chart.model().scene().items[0].bounds;
    };


    // Internal functions----------------------------------------------

    // Returns true if arrays have same contents (in any order), false otherwise.
    function arraysEqual(a, b) {
      return $(a).not(b).length === 0 && $(b).not(a).length === 0;
    }

    // Given a mark definition, property name, return an object with the
    // properties. If key is provided, then pull out that key.
    function getMarkProp(markdef, propname) {
      if (propname === undefined || propname === null) {
        return {};
      }
      var property = markdef.properties[propname];

      if (property === undefined || property === null) {
        return {};
      }

      // Call the property function on a dummy object
      var temp = {};
      property(temp);

      return temp;
    }


    // ggvis.Plot.Brush class --------------------------------------------------
    Plot.Brush = (function() {
      // Constructor
      // plot: The ggvis.Plot object which uses this brush.
      var brush = function(plot) {
        this.plot = plot;

        this._brushBounds = new vg.Bounds();
        this._clickPoint = null;      // Coordinates where mouse was clicked
        this._lastPoint = null;       // Previous mouse coordinate
        this._lastMatchingItems = [];
        this._callbacks = {};         // Named arrays of callback functions

        this._brushing = false;
        this._dragging = false;
      };

      var prototype = brush.prototype;

      // Register a callback which is run each time the brush is updated.
      // Events include "brushMove" and "updateItems"
      prototype.on = function(event, fn) {
        if (!this._callbacks[event]) {
          this._callbacks[event] = [];
        }
        this._callbacks[event].push(fn);
      };

      // Returns true if the plot has a brush object, false otherwise.
      prototype.hasBrush = function() {
        if (this._getBrushMarkDef()) return true;
        else return false;
      };

      // Enable the brush.
      prototype.enable = function() {
        var self = this;
        var $div = this.plot.getDiv();

        // Remove any existing handlers
        $div.off("mousedown.ggvis_brush");
        $div.off("mouseup.ggvis_brush");
        $div.off("mousemove.ggvis_brush");

        // Hook up handlers
        $div.on("mousedown.ggvis_brush", "div.vega", function (event) {
          var point = self._removePadding(mouseOffset(event));

          if (self._brushBounds.contains(point.x, point.y)) {
            self._startDragging(point);
          } else {
            self._startBrushing(point);
          }
        });
        $div.on("mouseup.ggvis_brush", "div.vega", function (event) {
          /* jshint unused: false */
          if (self._dragging) self._stopDragging();
          if (self._brushing) self._stopBrushing();
        });
        $div.on("mousemove.ggvis_brush", "div.vega", function (event) {
          var point = self._removePadding(mouseOffset(event));
          if (self._dragging) self._dragTo(point);
          if (self._brushing) self._brushTo(point);
        });

        // Register functions to be called each time brush is dragged or resized.
        self.on("brushMove", self._updateBrush);

        // It's not uncommong for mouse events to occur at up to 120 Hz, but
        // throttling brush updates to 20 Hz still gives a responsive feel, while
        // allowing the CPU to spend more time doing other stuff.
        var updateThrottled = _.throttle(self._updateBrushedItems, 50);
        self.on("brushMove", updateThrottled);
      };

      // Dragging functions
      prototype._startDragging = function(point) {
        this._dragging = true;
        this._lastPoint = point;
        this._clickPoint = point;
        this._trigger("brushMove");
      };
      prototype._dragTo = function(point) {
        if (!this._dragging) return;

        var dx = point.x - this._lastPoint.x;
        var dy = point.y - this._lastPoint.y;

        this._brushBounds.translate(dx, dy);
        this._lastPoint = point;
        this._trigger("brushMove");
      };
      prototype._stopDragging = function() {
        this._dragging = false;
        this._clickPoint = null;
        this._trigger("brushMove");
      };

      // Brushing functions
      prototype._startBrushing = function(point) {
        // Reset brush
        this._brushBounds.set(0, 0, 0, 0);
        this._brushing = true;
        this._clickPoint = point;
        this._trigger("brushMove");
      };
      prototype._brushTo = function(point) {
        if (!this._brushing) return; // We're not brushing right now

        var limits = this.plot._getSceneBounds();

        // Calculate the bounds based on start and end points
        var end = point;
        var maxX = Math.min(Math.max(this._clickPoint.x, end.x), limits.x2);
        var minX = Math.max(Math.min(this._clickPoint.x, end.x), limits.x1);
        var maxY = Math.min(Math.max(this._clickPoint.y, end.y), limits.y2);
        var minY = Math.max(Math.min(this._clickPoint.y, end.y), limits.y1);

        this._brushBounds.set(minX, minY, maxX, maxY);
        this._trigger("brushMove");
      };
      prototype._stopBrushing = function() {
        this._brushing = false;
        this._clickPoint = null;
        this._trigger("brushMove");
      };

      // Update the brush with new coordinates stored in brushBounds variable
      // and call update on plot.
      prototype._updateBrush = function() {
        this.plot.chart.data({
          ggvis_brush: [{
            x:      this._brushBounds.x1,
            y:      this._brushBounds.y1,
            width:  this._brushBounds.width(),
            height: this._brushBounds.height()
          }]
        });

        this.plot.chart.update({
          props: "update",
          items: this._getBrushItem()
        });
      };

      // Trigger callbacks for a named event. The callbacks are called with
      // `extra` as an argument.
      prototype._trigger = function(event, extra) {
        var callbacks = this._callbacks[event];

        for (var i = 0; i < callbacks.length; i++) {
          callbacks[i].call(this, extra);
        }
      };

      // Find items that are and aren't under the brush, then call update on
      // each set, with the "brush" or "update" property set, as appropriate.
      prototype._updateBrushedItems = function() {
        // TODO: This function is a performance bottleneck.
        //   Could use a faster method for finding array differences, but it'll
        //   probably be even better to track brushed and unbrushed items from
        //   the previous run.

        // Find the items in the current scene that match
        var items = this._getBrushableItems();
        var matchingItems = [];
        for (var i = 0; i < items.length; i++) {
          if (this._brushBounds.intersects(items[i].bounds)) {
            matchingItems.push(items[i]);
          }
        }

        var newBrushItems = _.difference(matchingItems, this._lastMatchingItems);
        var unBrushItems  = _.difference(this._lastMatchingItems, matchingItems);

        this._lastMatchingItems = matchingItems;

        this.plot.chart.update({ props: "brush", items: newBrushItems });
        this.plot.chart.update({ props: "update", items: unBrushItems });

        // Collect information run updateItems callbacks
        var bounds = this._brushBounds;
        var info = {
          plot_id: this.plot.plotId,
          x1: bounds.x1,
          x2: bounds.x2,
          y1: bounds.y1,
          y2: bounds.y2,
          items: matchingItems
        };
        this._trigger("updateItems", info);
      };


      // Return the definition of the brush mark
      prototype._getBrushMarkDef = function() {
        var def = _.find(this.plot._allMarkDefs(), function(markdef) {
          var data = getMarkProp(markdef, "ggvis").data || null;
          return data === "ggvis_brush";
        });

        if (def === undefined) return null;

        return def;
      };

      // Return the brush mark; if not present, return null.
      prototype._getBrushMark = function() {
        // We can identify the brush mark because it draws data from ggvis_brush.
        var brushMark = _.find(this.plot._allMarks(), function(mark) {
          var data = getMarkProp(mark.def, "ggvis").data || null;
          return data === "ggvis_brush";
        });

        if (brushMark === undefined) return null;

        return brushMark;
      };

      prototype._getBrushItem = function() {
        var brushMark = this._getBrushMark();
        if (brushMark === null || brushMark.items === null) return null;

        return brushMark.items[0];
      };

      // Return all brushable items
      prototype._getBrushableItems = function() {
        var brushableMarks = this.plot._allMarks().filter(function(mark) {
          if (_.isEmpty(getMarkProp(mark.def, "brush")))
            return false;
          else
            return true;
        });

        var items = _.pluck(brushableMarks, "items");
        return _.flatten(items);
      };

      // x/y coords are relative to the containing div. We need to account for the
      // padding that surrounds the data area by removing the padding before we
      // compare it to any scene item bounds.
      prototype._removePadding = function(point) {
        return {
          x: point.x - this.plot.chart.padding().left,
          y: point.y - this.plot.chart.padding().top
        };
      };

      // Internal functions --------------------------------------------
      function mouseOffset(e) {
        return {
          x: e.offsetX,
          y: e.offsetY
        };
      }

      return brush;
    })(); // ggvis.Plot.Brush

    return Plot;
  })(); // ggvis.Plot

  return ggvis;

})(lodash);


$(function(){ //DOM Ready

  // Don't close the dropdown when objects in it are clicked (by default
  // the dropdown menu closes when anything inside is clicked).
  // Need to bind to body instead of document for e.stopPropogation to catch
  // at appropriate point.
  $("body").on('click', '.ggvis-control.dropdown-menu', function(e) {
    e.stopPropagation();
  });

  $("body").on("click", ".ggvis-download", function() {
    var plot = ggvis.plots[$(this).data("plot-id")];
    plot.updateDownloadLink(this);
  });

  $("body").on("click", ".ggvis-renderer-buttons .btn", function(e) {
    var $el = $(this);
    var plot = ggvis.plots[$el.data("plot-id")];

    plot.setRenderer($el.data("renderer"));

    // Don't close the dropdown
    e.stopPropagation();
  });

});
