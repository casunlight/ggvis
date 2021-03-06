\name{as.vega}
\alias{as.vega}
\alias{as.vega.ggvis}
\title{Coerce an ggvis object to a vega list.}
\usage{
  as.vega(x, ...)

  \method{as.vega}{ggvis} (x, session = NULL,
    dynamic = FALSE, ...)
}
\arguments{
  \item{x}{an object to convert to vega}

  \item{session}{a session object from shiny}

  \item{dynamic}{whether to generate dynamic or static
  spec}
}
\value{
  a list. When converted to JSON, will be the type of
  structure that vega expects.
}
\description{
  This generic function powers the coercion of ggvis
  objects to vega compatible data structures.
}
\keyword{internal}

