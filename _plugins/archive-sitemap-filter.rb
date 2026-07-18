# frozen_string_literal: true

# Keep thin tag/category archive pages out of sitemap.xml.
Jekyll::Hooks.register :site, :pre_render do |site|
  site.pages.each do |page|
    next unless page.respond_to?(:url)

    if page.url.start_with?("/tags/", "/categories/")
      page.data["sitemap"] = false
    end
  end
end
